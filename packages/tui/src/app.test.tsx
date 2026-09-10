import { expect, test } from 'bun:test';
import { useKeyboard } from '@opentui/react';
import { testRender } from '@opentui/react/test-utils';
import { Effect, Layer, ManagedRuntime, Schema } from 'effect';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, useState } from 'react';
import { writeCodexFixture } from '../../../test/codex-fixture';
import { Client, requireSupportedBun } from '@pipes/protocol';
import { Repository, Run, Snapshot, Task } from '@pipes/protocol';
import { App, StatusText, statusVisuals, TaskDetails, workflowProgress } from './app';
import { CodexSetup } from './codex-setup';
import { readOnboarding } from './onboarding';
import { completePath, directories, expandPath, gitRoot } from './repository-picker';
import { claimWelcome, logo, Welcome } from './welcome';

test('directory listing includes folder symlinks and skips files, broken links, and .git', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pipes-directories-'));
  mkdirSync(join(directory, 'folder'));
  mkdirSync(join(directory, '.git'));
  writeFileSync(join(directory, 'file'), '');
  symlinkSync('folder', join(directory, 'linked-folder'));
  symlinkSync('file', join(directory, 'linked-file'));
  symlinkSync('missing', join(directory, 'broken'));
  expect(await directories(directory)).toEqual(['folder', 'linked-folder']);
});

test('parent renders do not restart a pending Codex check', async () => {
  let checks = 0;
  let cancelled = 0;
  const runtime = ManagedRuntime.make(
    Layer.effect(
      Client,
      Effect.map(Client, (client) =>
        Client.of({
          ...client,
          codexProbe: () =>
            Effect.sync(() => {
              checks++;
            }).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  cancelled++;
                }),
              ),
            ),
        }),
      ),
    ).pipe(
      Layer.provide(
        Client.layer({
          directory: tmpdir(),
          port: 1,
          token: 'test',
          url: 'http://127.0.0.1:1',
        }),
      ),
    ),
  );
  function Parent() {
    const [render, setRender] = useState(0);
    useKeyboard(() => setRender((value) => value + 1));
    return (
      <box>
        <text>{render}</text>
        <CodexSetup onClose={() => {}} onReady={() => {}} path={tmpdir()} runtime={runtime} />
      </box>
    );
  }
  const view = await testRender(<Parent />, { height: 24, width: 100 });
  try {
    await act(async () => {
      await Bun.sleep(50);
    });
    expect(checks).toBe(1);
    await act(async () => {
      view.mockInput.pressKey('x');
    });
    expect(checks).toBe(1);
    expect(cancelled).toBe(0);
  } finally {
    await act(async () => {
      view.renderer.destroy();
    });
    await runtime.dispose();
  }
  expect(cancelled).toBe(1);
});

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
    await view.waitForFrame((frame) => frame.includes('Press [any key]'));
    expect(view.captureCharFrame()).not.toContain('Queue ready');
    await act(async () => {
      await Bun.sleep(160);
    });
    expect(view.captureCharFrame()).toContain(logo.slice(0, 5));
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
    await skipped.waitForFrame((frame) => frame.includes('Press [any key]'));
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
    expect(reopened.captureCharFrame()).not.toContain('Press [any key]');
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

function Statuses() {
  const [running, setRunning] = useState(true);
  useKeyboard(() => setRunning(false));
  return (
    <box flexDirection="column">
      {Object.keys(statusVisuals)
        .filter((status) => status !== 'running')
        .map((status) => (
          <StatusText key={status} status={status as keyof typeof statusVisuals} />
        ))}
      <StatusText status={running ? 'running' : 'completed'} />
    </box>
  );
}

test('statuses pair glyphs with labels and animate only while running', async () => {
  const view = await testRender(<Statuses />, { height: 20, width: 60 });
  try {
    await view.flush();
    const before = view.captureCharFrame();
    for (const visual of Object.values(statusVisuals)) {
      expect(before).toContain(`${visual.icon} ${visual.label}`);
    }
    await act(async () => {
      await Bun.sleep(100);
    });
    await view.flush();
    expect(view.captureCharFrame()).not.toBe(before);
    await act(async () => {
      view.mockInput.pressKey('x');
    });
    await view.flush();
    const stopped = view.captureCharFrame();
    expect(stopped).not.toContain('running');
    await act(async () => {
      await Bun.sleep(100);
    });
    await view.flush();
    expect(view.captureCharFrame()).toBe(stopped);
  } finally {
    await act(async () => {
      view.renderer.destroy();
    });
  }
});

test('workflow progress shows ordered steps and their latest state', () => {
  const agent = { model: 'small', provider: 'codex' as const, reasoning: 'low' };
  expect(
    workflowProgress({
      attempts: [
        { id: 'old', status: 'interrupted', step: 'plan', transcript: '' },
        { id: 'new', status: 'completed', step: 'plan', transcript: '' },
      ],
      configuration: {
        workflows: {
          delivery: {
            steps: [
              { agent, name: 'plan', prompt: 'Plan the work.' },
              { agent, name: 'build', prompt: 'Build it.' },
            ],
          },
        },
      },
      workflow: 'delivery',
    }),
  ).toEqual([
    { name: 'plan', status: 'completed' },
    { name: 'build', status: 'waiting' },
  ]);
});

test('task tracking leads with state and collapses content and repeated evidence', async () => {
  const task = new Task({
    brief: `${'A long request that wraps across the terminal. '.repeat(15)}\nHidden ending`,
    createdAt: '2026-09-09T10:00:00Z',
    id: 'task-id',
    repositoryId: 'repo',
    status: 'interrupted',
    title: 'Track this task',
  });
  const run = new Run({
    attempts: [
      {
        id: 'attempt',
        result: { status: 'failed', summary: 'Worker stopped.' },
        status: 'interrupted',
        step: 'plan',
        transcript: '/evidence/transcript.jsonl',
      },
    ],
    baseRevision: 'base',
    branch: 'work-branch',
    brief: task.brief,
    configuration: {
      workflows: {
        delivery: {
          steps: [
            {
              agent: { model: 'small', provider: 'codex', reasoning: 'low' },
              name: 'plan',
              prompt: 'Plan.',
            },
          ],
        },
      },
    },
    createdAt: '2026-09-09T11:00:00Z',
    id: 'run-id',
    status: 'interrupted',
    summary: 'Worker stopped.',
    taskId: task.id,
    title: task.title,
    workflow: 'delivery',
    workspace: '/worktree',
  });
  const snapshot = new Snapshot({
    repositories: [],
    runs: [run],
    tasks: [task],
    transitions: [{ createdAt: task.createdAt, id: 1, kind: 'submitted', taskId: task.id }],
  });
  const view = await testRender(
    <TaskDetails active repository="pipes" run={run} snapshot={snapshot} task={task} />,
    { height: 45, width: 70 },
  );
  try {
    await act(async () => {
      await view.flush();
    });
    await view.flush();
    const frame = view.captureCharFrame();
    expect(frame).toContain('Ⅱ plan · interrupted');
    expect(frame).not.toContain('Technical details');
    expect(frame).not.toContain('[d]');
    expect(frame).not.toContain('Hidden ending');
    expect(frame).not.toContain('/evidence');
    expect(frame.match(/Worker stopped\./g)).toHaveLength(1);
    expect(frame.match(/delivery/g)).toHaveLength(1);
    expect(frame).toContain('Description · [b] expand');
    expect(frame).toContain('...');
    expect(frame.match(/Ⅱ plan · interrupted/g)).toHaveLength(1);
    expect(frame.indexOf('delivery')).toBeLessThan(frame.indexOf('Activity'));
    expect(frame.indexOf('Worker stopped.')).toBeLessThan(frame.indexOf('Description'));
    expect(frame.indexOf('Run started')).toBeLessThan(frame.indexOf('submitted'));
    expect(
      frame.split('\n').filter((line) => line.includes('A long request')).length,
    ).toBeLessThanOrEqual(3);
    await act(async () => {
      view.mockInput.pressKey('b');
      view.mockInput.pressKey('d');
    });
    await view.flush();
    expect(view.captureCharFrame()).toContain('Hidden ending');
    expect(view.captureCharFrame()).toContain('Description · [b] collapse');
    expect(view.captureCharFrame()).not.toContain('...');
    expect(view.captureCharFrame()).not.toContain('/evidence/transcript.jsonl');
    await act(async () => {
      view.mockInput.pressKey('b');
      view.mockInput.pressKey('d');
    });
    await view.flush();
    expect(view.captureCharFrame()).not.toContain('Hidden ending');
    expect(view.captureCharFrame()).not.toContain('/evidence');
  } finally {
    await act(async () => {
      view.renderer.destroy();
    });
  }
});

test('description ellipsis appears only when content is clipped', async () => {
  for (const brief of ['Short description.', 'One\nTwo\nThree', 'One\nTwo\nThree\nFour']) {
    const task = new Task({
      brief,
      createdAt: '',
      id: 'task',
      repositoryId: 'repo',
      status: 'queued',
      title: 'Task',
    });
    const view = await testRender(
      <TaskDetails
        active
        repository="pipes"
        run={undefined}
        snapshot={new Snapshot({ repositories: [], tasks: [task], transitions: [] })}
        task={task}
      />,
      { height: 30, width: 70 },
    );
    try {
      await act(async () => {
        await view.flush();
      });
      await view.flush();
      expect(view.captureCharFrame().includes('...')).toBe(brief.includes('Four'));
    } finally {
      await act(async () => {
        view.renderer.destroy();
      });
    }
  }
});

test('CLI, live terminal queue, validation, and server restart share durable state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pipes-test-'));
  const seed = join(directory, 'pipes');
  mkdirSync(join(seed, '.pipes'), { recursive: true });
  writeFileSync(join(seed, '.pipes/config.ts'), readFileSync('.pipes/config.ts'));
  expect(
    await Bun.spawn(['git', 'init', seed], { stderr: 'ignore', stdout: 'ignore' }).exited,
  ).toBe(0);
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
  const command = [process.execPath, writeCodexFixture(directory)];
  const env = {
    ...process.env,
    PIPES_DATA_DIR: directory,
    PIPES_PORT: String(port),
  };
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
    const missingAgentDirectory = await cli('agent', join(directory, 'missing'));
    expect(missingAgentDirectory.code).not.toBe(0);
    expect(missingAgentDirectory.stdout + missingAgentDirectory.stderr).toContain('Cannot launch');
    const registered = await cli('register', seed);
    expect(registered.code).toBe(0);
    const repository = Schema.decodeUnknownSync(Repository)(JSON.parse(registered.stdout));
    const again = await cli('register', seed);
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
    runtime = ManagedRuntime.make(
      Layer.effect(
        Client,
        Effect.map(Client, (client) =>
          Client.of({
            ...client,
            codexProbe: (input, options) => client.codexProbe({ ...input, command }, options),
            codexSetup: (input, options) =>
              client.codexSetup({ ...input, agent: { ...input.agent, command } }, options),
          }),
        ),
      ).pipe(Layer.provide(Client.layer(connection))),
    );
    view = await testRender(
      <App
        onboardingDirectory={directory}
        onJumpIn={async () => {}}
        onQuit={() => {}}
        runtime={runtime}
        startDirectory={nested}
      />,
      {
        height: 32,
        width: 110,
      },
    );
    const waitForAgent = async (text: string) => {
      for (let attempt = 0; attempt < 60; attempt++) {
        await act(async () => {
          await Bun.sleep(50);
        });
        await view!.flush();
        if (view!.captureCharFrame().includes(text)) {
          return;
        }
      }
      expect(view!.captureCharFrame()).toContain(text);
    };
    await waitForAgent('Connect this repository');
    expect(view.captureCharFrame()).toContain('1/3');
    await act(async () => {
      view!.mockInput.pressKey('RETURN');
    });
    await waitForAgent('Connected to Codex');
    expect(view.captureCharFrame()).not.toContain('Choose a model');
    expect(view.captureCharFrame()).toContain('2/3');
    expect(readOnboarding(directory).complete).toBe(false);
    await act(async () => {
      view!.mockInput.pressKey('ESCAPE');
    });
    await act(async () => {
      view!.renderer.destroy();
    });
    view = await testRender(
      <App
        onboardingDirectory={directory}
        onJumpIn={async () => {}}
        onQuit={() => {}}
        runtime={runtime}
        startDirectory={nested}
      />,
      { height: 32, width: 110 },
    );
    await waitForAgent('Connected to Codex');
    await act(async () => {
      view!.mockInput.pressKey('RETURN');
    });
    await waitForAgent('example pipes.');
    expect(view.captureCharFrame()).toContain('3/3');
    expect(view.captureCharFrame()).not.toContain('Connected to Codex');
    expect(view.captureCharFrame()).toContain('export default {');
    expect(view.captureCharFrame()).toContain("name: 'review'");
    expect(view.captureCharFrame()).not.toContain('Choose a model');
    expect(readOnboarding(directory).complete).toBe(false);
    expect(view.captureCharFrame()).toContain('[Enter] create');
    await act(async () => {
      view!.mockInput.pressKey('RETURN');
      await Bun.sleep(500);
    });
    for (let attempt = 0; attempt < 60 && !readOnboarding(directory).complete; attempt++) {
      await act(async () => {
        await Bun.sleep(50);
      });
    }
    expect(readOnboarding(directory).complete).toBe(true);
    await waitForAgent('✓ Setup complete');
    expect(view.captureCharFrame()).not.toContain('Setup · 3/3');
    await act(async () => {
      const configured = await cli('config', first);
      expect(configured.code).toBe(0);
      expect(
        JSON.parse(configured.stdout).workflows['plan-implement-review'].steps[0].agent,
      ).toEqual({ command, model: 'small', provider: 'codex', reasoning: 'low' });
      const discovered = await cli(
        'agent',
        first,
        '--command',
        JSON.stringify(command),
        '--model',
        'large',
        '--reasoning',
        'high',
      );
      expect(discovered.code).toBe(0);
      expect(JSON.parse(discovered.stdout).reasoning).toBe('high');
      expect((await cli('agent', first, '--setup')).code).not.toBe(0);
      expect((await cli('agent', first, '--command', '[]')).code).not.toBe(0);
    });
    expect((await list()).repositories).toHaveLength(2);
    await act(async () => {
      view!.renderer.destroy();
    });
    view = await testRender(
      <App
        onboardingDirectory={directory}
        onJumpIn={async () => {}}
        onQuit={() => {}}
        runtime={runtime}
        startDirectory={nested}
      />,
      { height: 32, width: 110 },
    );
    await waitForAgent('● connected');
    expect(view.captureCharFrame()).not.toContain('Setup ·');
    expect(view.captureCharFrame()).toContain('[m] manage');
    expect(view.captureCharFrame()).not.toContain('[↑↓] scroll');
    await act(async () => {
      view!.mockInput.pressKey('m');
    });
    await view.waitForFrame((frame) => frame.includes('Connections') && frame.includes('Agent'));
    await act(async () => {
      view!.mockInput.pressKey('TAB');
    });
    await view.waitForFrame((frame) => frame.includes('Checking Codex'));
    expect(view.captureCharFrame()).toContain('Manage');
    expect(view.captureCharFrame()).toContain('Connections');
    await act(async () => {
      view!.mockInput.pressKey('TAB');
    });
    await view.waitForFrame((frame) => frame.includes('Add a repository'));
    expect(view.captureCharFrame()).toContain('Manage');
    expect(view.captureCharFrame()).toContain('Repositories');
    expect(view.captureCharFrame()).toContain('● pipes');
    expect(view.captureCharFrame()).toContain('● a project');
    expect(view.captureCharFrame()).toContain('Add a repository');
    expect(view.captureCharFrame()).toContain('❯ Connect this repository');
    expect(view.captureCharFrame()).toContain('Browse local directories');
    expect(view.captureCharFrame()).toContain('Clone from GitHub');
    expect(view.captureCharFrame()).toContain('[↑↓] choose · [Enter] select');
    await act(async () => {
      view!.mockInput.pressKey('ARROW_DOWN');
      view!.mockInput.pressKey('RETURN');
      await Bun.sleep(100);
    });
    await view.waitForFrame((frame) => frame.includes('Git repository'));
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
      (frame) => frame.includes('Git repository') && frame.includes('b project'),
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
      view!.mockInput.pressKey('e', { ctrl: true });
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
    await view.waitForFrame((frame) => frame.includes('Connect this repository'));
    await act(async () => {
      view!.mockInput.pressKey('RETURN');
      await Bun.sleep(200);
    });
    await view.waitForFrame((frame) => !frame.includes('[Enter] selects'));
    expect((await list()).repositories).toHaveLength(3);
    await act(async () => {
      view!.mockInput.pressKey('m');
      await Bun.sleep(100);
    });
    await act(async () => {
      view!.mockInput.pressKey('ESCAPE');
      await Bun.sleep(100);
    });
    await view.waitForFrame((frame) => !frame.includes('[Enter] selects'));
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
    expect(view.captureCharFrame()).toContain('queued · manual');
    expect(view.captureCharFrame()).not.toContain('queued · pipes');
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
      Bun.spawn([process.execPath, 'run', 'reset'], { env, stderr: 'pipe', stdout: 'pipe' });
    expect(await reset().exited).toBe(0);
    expect(existsSync(join(directory, 'pipes.sqlite'))).toBe(false);
    expect(existsSync(join(directory, 'onboarding.json'))).toBe(false);
    expect(existsSync(join(first, '.pipes/config.ts'))).toBe(false);
    expect(await reset().exited).toBe(0);
    expect(await list()).toEqual(
      new Snapshot({ repositories: [], runs: [], tasks: [], transitions: [] }),
    );
  } finally {
    await act(async () => {
      view?.renderer.destroy();
    });
    await runtime?.dispose();
    await cli('shutdown');
  }
}, 20_000);
