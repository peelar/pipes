import { expect, test } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import { ManagedRuntime, Schema } from 'effect';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { Client, requireSupportedBun } from '../client/connection';
import { Repository, Snapshot } from '../protocol/pipes';
import { App } from './app';
import { completePath, expandPath, gitRoot } from './repository-picker';
import { claimWelcome, logo, Welcome } from './welcome';

test('first launch animates the README logo once, continues automatically, and supports skipping', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pipes-welcome-'));
  expect(readFileSync('README.md', 'utf8')).toContain(logo);
  const firstLaunch = claimWelcome(directory);
  expect(firstLaunch).toBe(true);
  expect(claimWelcome(directory)).toBe(false);
  const view = await testRender(
    <Welcome firstLaunch={firstLaunch}>
      <text>Queue ready</text>
    </Welcome>,
    { height: 24, width: 80 },
  );
  try {
    await view.waitForFrame((frame) => frame.includes('Press any key'));
    expect(view.captureCharFrame()).not.toContain('Queue ready');
    await act(async () => {
      await Bun.sleep(160);
    });
    expect(view.captureCharFrame()).toContain('╭────');
    expect(view.captureCharFrame()).not.toContain(logo.split('\n')[0]!);
    await act(async () => {
      await Bun.sleep(1000);
    });
    expect(view.captureCharFrame()).toContain(logo.split('\n')[0]!);
    await act(async () => {
      await Bun.sleep(700);
    });
    await view.waitForFrame((frame) => frame.includes('Queue ready'));
  } finally {
    await act(async () => {
      view.renderer.destroy();
    });
  }
  const skipped = await testRender(
    <Welcome firstLaunch>
      <text>Queue ready</text>
    </Welcome>,
    { height: 24, width: 80 },
  );
  try {
    await skipped.waitForFrame((frame) => frame.includes('Press any key'));
    await act(async () => {
      skipped.mockInput.pressKey('RETURN');
    });
    await skipped.waitForFrame((frame) => frame.includes('Queue ready'));
  } finally {
    await act(async () => {
      skipped.renderer.destroy();
    });
  }
  const reopened = await testRender(
    <Welcome firstLaunch={claimWelcome(directory)}>
      <text>Queue ready</text>
    </Welcome>,
    { height: 24, width: 80 },
  );
  try {
    await reopened.waitForFrame((frame) => frame.includes('Queue ready'));
    expect(reopened.captureCharFrame()).not.toContain('Press any key');
  } finally {
    await act(async () => {
      reopened.renderer.destroy();
    });
  }
});

test('unsupported Bun fails with upgrade instructions before server startup', () => {
  expect(() => requireSupportedBun('1.0.26')).toThrow('Run bun upgrade');
  expect(() => requireSupportedBun('1.4.2')).not.toThrow();
  expect(() => requireSupportedBun('1.10.0')).not.toThrow();
});

test('CLI, live terminal queue, validation, and server restart share durable state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pipes-test-'));
  const projects = join(directory, 'projects');
  const first = join(projects, 'a project');
  const second = join(projects, 'b project');
  const nested = join(first, 'nested');
  mkdirSync(nested, { recursive: true });
  mkdirSync(second, { recursive: true });
  for (const path of [first, second]) {
    expect(
      await Bun.spawn(['git', 'init', path], { stderr: 'ignore', stdout: 'ignore' }).exited,
    ).toBe(0);
  }
  expect(await gitRoot(nested)).toBe(await gitRoot(first));
  expect(await gitRoot(projects)).toBeUndefined();
  expect(expandPath('~', projects)).toBe(homedir());
  expect(expandPath('~/Code', projects)).toBe(join(homedir(), 'Code'));
  expect((await completePath('b', projects)).value).toBe(`${second}/`);
  expect((await completePath('missing', projects)).message).toBe('No matching directories.');
  const reservation = Bun.serve({ fetch: () => new Response(), port: 0 });
  const port = reservation.port!;
  await reservation.stop(true);
  const env = { ...process.env, PIPES_DATA_DIR: directory, PIPES_PORT: String(port) };
  const cli = async (...args: Array<string>) => {
    const child = Bun.spawn([process.execPath, 'src/cli.ts', ...args], {
      env,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stderr, stdout };
  };
  const list = async () => {
    const result = await cli('list', '--json');
    if (result.code !== 0) {
      const log = join(directory, 'server.log');
      throw new Error(
        `${result.stdout}\n${result.stderr}\n${existsSync(log) ? readFileSync(log, 'utf8') : ''}`,
      );
    }
    return Schema.decodeUnknownSync(Snapshot)(JSON.parse(result.stdout));
  };

  let runtime: ManagedRuntime.ManagedRuntime<Client, never> | undefined;
  let view: Awaited<ReturnType<typeof testRender>> | undefined;
  try {
    expect((await list()).tasks).toHaveLength(0);
    const registered = await cli('register', process.cwd());
    expect(registered.code).toBe(0);
    const repository = Schema.decodeUnknownSync(Repository)(JSON.parse(registered.stdout));
    const again = await cli('register', process.cwd());
    expect(JSON.parse(again.stdout).id).toBe(repository.id);
    expect((await cli('register', directory)).code).not.toBe(0);
    expect((await cli('submit', '   ', '--repo', repository.id)).code).not.toBe(0);
    expect((await cli('submit', 'Wrong repo', '--repo', 'missing')).code).not.toBe(0);
    expect((await list()).tasks).toHaveLength(0);

    const connection = {
      directory,
      port,
      token: readFileSync(join(directory, 'token'), 'utf8'),
      url: `http://127.0.0.1:${port}`,
    };
    expect((await fetch(`${connection.url}/health`)).status).toBe(403);
    runtime = ManagedRuntime.make(Client.layer(connection));
    view = await testRender(<App onQuit={() => {}} runtime={runtime} startDirectory={nested} />, {
      height: 32,
      width: 110,
    });
    await act(async () => {
      await Bun.sleep(100);
    });
    await view.waitForFrame((frame) => frame.includes('Do you want to initialize'));
    expect(view.captureCharFrame()).toContain('Queue');
    expect(view.captureCharFrame()).toContain('● connected');
    await act(async () => {
      view!.mockInput.pressKey('r');
    });
    expect(view.captureCharFrame()).not.toContain('Enter selects');
    expect((await list()).repositories).toHaveLength(1);
    await act(async () => {
      view!.mockInput.pressKey('n');
      await Bun.sleep(1100);
    });
    await view.waitForFrame((frame) => frame.includes('connected'));
    expect(view.captureCharFrame()).not.toContain('Do you want to initialize');
    expect((await list()).repositories).toHaveLength(1);
    await act(async () => {
      view!.renderer.destroy();
    });
    view = await testRender(<App onQuit={() => {}} runtime={runtime} startDirectory={nested} />, {
      height: 32,
      width: 110,
    });
    await act(async () => {
      await Bun.sleep(100);
    });
    await view.waitForFrame((frame) => frame.includes('Do you want to initialize'));
    await act(async () => {
      view!.mockInput.pressKey('RETURN');
      await Bun.sleep(200);
    });
    await view.waitForFrame((frame) => frame.includes('connected') && frame.includes('Press n'));
    expect((await list()).repositories).toHaveLength(2);
    await act(async () => {
      view!.renderer.destroy();
    });
    view = await testRender(<App onQuit={() => {}} runtime={runtime} startDirectory={nested} />, {
      height: 32,
      width: 110,
    });
    await act(async () => {
      await Bun.sleep(100);
    });
    await view.waitForFrame((frame) => frame.includes('connected'));
    expect(view.captureCharFrame()).not.toContain('Do you want to initialize');
    await act(async () => {
      view!.mockInput.pressKey('r');
      await Bun.sleep(100);
    });
    await act(async () => {
      await Bun.sleep(100);
    });
    await view.waitForFrame((frame) => frame.includes('Git repository:'));
    await act(async () => {
      view!.mockInput.pressKey('ARROW_LEFT');
      await Bun.sleep(100);
    });
    await act(async () => {
      view!.mockInput.pressKey('ARROW_LEFT');
      await Bun.sleep(100);
    });
    await act(async () => {
      await Bun.sleep(100);
    });
    await view.waitForFrame((frame) => frame.includes('Not a Git repository'));
    await act(async () => {
      view!.mockInput.pressKey('ARROW_DOWN');
      view!.mockInput.pressKey('ARROW_DOWN');
      view!.mockInput.pressKey('RETURN');
    });
    await act(async () => {
      await Bun.sleep(100);
    });
    await view.waitForFrame(
      (frame) => frame.includes('Git repository:') && frame.includes('b project'),
    );
    await act(async () => {
      view!.mockInput.pressKey('ARROW_LEFT');
    });
    await act(async () => {
      await Bun.sleep(100);
    });
    await view.waitForFrame((frame) => frame.includes('Not a Git repository'));
    await act(async () => {
      view!.mockInput.pressKey('p');
    });
    await view.flush();
    await act(async () => {
      await view!.mockInput.typeText('b');
    });
    await act(async () => {
      view!.mockInput.pressKey('TAB');
      await Bun.sleep(100);
    });
    await view.waitForFrame((frame) => frame.includes('projects/b project/'));
    await act(async () => {
      view!.mockInput.pressKey('RETURN');
      await Bun.sleep(100);
    });
    await act(async () => {
      await Bun.sleep(100);
    });
    await view.waitForFrame((frame) => frame.includes('Register this repository'));
    await act(async () => {
      view!.mockInput.pressKey('RETURN');
      await Bun.sleep(200);
    });
    await view.waitForFrame((frame) => !frame.includes('Enter selects'));
    expect((await list()).repositories).toHaveLength(3);
    await act(async () => {
      view!.mockInput.pressKey('r');
    });
    await act(async () => {
      await Bun.sleep(100);
    });
    await act(async () => {
      view!.mockInput.pressKey('ESCAPE');
      await Bun.sleep(100);
    });
    await view.waitForFrame((frame) => !frame.includes('Enter selects'));
    expect((await list()).repositories).toHaveLength(3);
    await act(async () => {
      const submitted = await cli(
        'submit',
        'A real task',
        '--repo',
        repository.id,
        '--brief',
        'Persist this brief.',
      );
      expect(submitted.code).toBe(0);
      await Bun.sleep(1100);
    });
    await view.waitForFrame(
      (frame) => frame.includes('A real task') && frame.includes('Persist this brief.'),
    );
    expect(view.captureCharFrame()).toContain('submitted');
    await act(async () => {
      view!.mockInput.pressKey('n');
    });
    await view.flush();
    expect(view.captureCharFrame()).toContain('New task');
    await act(async () => {
      await view!.mockInput.typeText('Created in the TUI');
      view!.mockInput.pressKey('RETURN');
    });
    await view.flush();
    expect(view.captureCharFrame()).toContain('Markdown brief');
    await act(async () => {
      await view!.mockInput.typeText('A terminal-authored brief');
      view!.mockInput.pressKey('s', { ctrl: true });
      await Bun.sleep(200);
    });
    await view.waitForFrame((frame) => frame.includes('Created in the TUI'));
    await act(async () => {
      view!.renderer.destroy();
    });
    view = undefined;
    await runtime.dispose();
    runtime = undefined;

    const before = await list();
    expect(before.tasks).toHaveLength(2);
    expect(before.transitions).toHaveLength(2);
    expect(before.tasks[1]?.brief).toBe('A terminal-authored brief');
    expect((await cli('shutdown')).code).toBe(0);
    await Bun.sleep(300);
    expect(await list()).toEqual(before);
    const reset = () =>
      Bun.spawn([process.execPath, 'run', 'db:reset'], { env, stderr: 'pipe', stdout: 'pipe' });
    expect(await reset().exited).toBe(0);
    expect(existsSync(join(directory, 'pipes.sqlite'))).toBe(false);
    expect(await reset().exited).toBe(0);
    expect(await list()).toEqual(new Snapshot({ repositories: [], tasks: [], transitions: [] }));
  } finally {
    await act(async () => {
      view?.renderer.destroy();
    });
    await runtime?.dispose();
    await cli('shutdown');
  }
}, 20_000);
