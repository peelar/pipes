import { expect, test } from 'bun:test';
import { Effect, ManagedRuntime } from 'effect';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client, ensureServer } from './client/connection';

test('dev replaces an old daemon, reloads server and TUI together, and preserves the queue', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pipes-dev-'));
  const reservation = Bun.serve({ fetch: () => new Response(), port: 0 });
  const port = reservation.port!;
  await reservation.stop(true);
  const connection = { directory, port, token: 'dev-test-token', url: `http://127.0.0.1:${port}` };
  const runtime = ManagedRuntime.make(Client.layer(connection));
  let child: Bun.Subprocess | undefined;
  try {
    await writeFile(join(directory, 'token'), connection.token, { mode: 0o600 });
    await cp('src', join(directory, 'src'), { recursive: true });
    await cp('tsconfig.json', join(directory, 'tsconfig.json'));
    await symlink(resolve('node_modules'), join(directory, 'node_modules'));
    const repositoryPath = join(directory, 'project');
    await mkdir(repositoryPath);
    expect(
      await Bun.spawn(['git', 'init', repositoryPath], { stderr: 'ignore', stdout: 'ignore' })
        .exited,
    ).toBe(0);
    await runtime.runPromise(ensureServer(connection));
    const client = await runtime.runPromise(Client);
    const repository = await runtime.runPromise(client.register({ path: repositoryPath }));
    await runtime.runPromise(
      client.submit({
        brief: 'Keep me across reloads.',
        repositoryId: repository.id,
        title: 'Dogfood',
      }),
    );
    const before = await runtime.runPromise(client.snapshot());
    const serverPath = join(directory, 'src/server.ts');
    const uiPath = join(directory, 'src/tui/app.tsx');
    const serverSource = await readFile(serverPath, 'utf8');
    const uiSource = await readFile(uiPath, 'utf8');
    await writeFile(serverPath, `${serverSource}\nexport const reloadMarker = 1;\n`);
    await writeFile(uiPath, `${uiSource}\nexport const reloadMarker = 1;\n`);
    const readyPath = join(directory, 'ready.json');
    await writeFile(
      join(directory, 'watch.ts'),
      `
import { BunRuntime, BunServices } from '@effect/platform-bun';
import { Effect } from 'effect';
import { writeFileSync } from 'node:fs';
import { develop } from './src/dev';
import { reloadMarker as server } from './src/server';
import { reloadMarker as ui } from './src/tui/app';
develop(${JSON.stringify(connection)}, async (_, signal) => {
  writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ server, ui }));
  await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
}).pipe(Effect.provide(BunServices.layer), BunRuntime.runMain);
`,
    );
    child = Bun.spawn([process.execPath, '--watch', 'watch.ts'], {
      cwd: directory,
      stderr: 'pipe',
      stdout: 'ignore',
    });
    const waitFor = async (server: number, ui: number) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const ready = await readFile(readyPath, 'utf8').catch(() => '');
        if (ready === JSON.stringify({ server, ui })) {
          return;
        }
        await Bun.sleep(50);
      }
      throw new Error(`Dev did not reload to server=${server}, ui=${ui}`);
    };
    await waitFor(1, 1);
    await writeFile(serverPath, `${serverSource}\nexport const reloadMarker = 2;\n`);
    await waitFor(2, 1);
    await writeFile(uiPath, `${uiSource}\nexport const reloadMarker = 2;\n`);
    await waitFor(2, 2);
    expect(await runtime.runPromise(client.snapshot())).toEqual(before);
    child.kill('SIGTERM');
    await child.exited;
    await expect(runtime.runPromise(ensureServer(connection, false))).rejects.toThrow(
      'Pipes server is not running.',
    );
  } finally {
    child?.kill('SIGTERM');
    await child?.exited;
    await runtime.runPromise(Effect.flatMap(Client, (client) => client.shutdown())).catch(() => {});
    await runtime.dispose();
    await rm(directory, { force: true, recursive: true });
  }
}, 20_000);
