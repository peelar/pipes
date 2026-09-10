import { expect, test } from 'bun:test';
import { Effect, ManagedRuntime } from 'effect';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client, ensureServer } from './client/connection';

test('dev applies pending migrations before opening the TUI on startup and watch reload, preserving the queue', async () => {
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
    await cp('skills', join(directory, 'skills'), { recursive: true });
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
    const storePath = join(directory, 'src/server/store.ts');
    const storeSource = await readFile(storePath, 'utf8');
    const withMigrations = (count: number) =>
      storeSource.replace(
        "'0001_queue':",
        Array.from(
          { length: count },
          (_, index) =>
            `'000${index + 8}_dev_test': sql\`CREATE TABLE dev_migration_${index} (id INTEGER)\`,`,
        ).join('\n') + "'0001_queue':",
      );
    await writeFile(storePath, withMigrations(1));
    const readyPath = join(directory, 'ready.json');
    await writeFile(
      join(directory, 'watch.ts'),
      `
import { BunRuntime, BunServices } from '@effect/platform-bun';
import { Database } from 'bun:sqlite';
import { Effect } from 'effect';
import { writeFileSync } from 'node:fs';
import { develop } from './src/dev';
import { reloadMarker as server } from './src/server';
import { reloadMarker as ui } from './src/tui/app';
develop(${JSON.stringify(connection)}, async (_, signal) => {
  const database = new Database(${JSON.stringify(join(directory, 'pipes.sqlite'))}, { readonly: true });
  const migrations = database.query("SELECT name FROM sqlite_master WHERE name LIKE 'dev_migration_%'").all().length;
  database.close();
  writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ migrations, server, ui }));
  await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
}).pipe(Effect.provide(BunServices.layer), BunRuntime.runMain);
`,
    );
    child = Bun.spawn([process.execPath, '--watch', 'watch.ts'], {
      cwd: directory,
      stderr: 'pipe',
      stdout: 'ignore',
    });
    const waitFor = async (server: number, ui: number, migrations = 1) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const ready = await readFile(readyPath, 'utf8').catch(() => '');
        if (ready === JSON.stringify({ migrations, server, ui })) {
          return;
        }
        await Bun.sleep(50);
      }
      throw new Error(`Dev did not reload to server=${server}, ui=${ui}, migrations=${migrations}`);
    };
    await waitFor(1, 1);
    await writeFile(serverPath, `${serverSource}\nexport const reloadMarker = 2;\n`);
    await waitFor(2, 1);
    await writeFile(uiPath, `${uiSource}\nexport const reloadMarker = 2;\n`);
    await waitFor(2, 2);
    await writeFile(storePath, withMigrations(2));
    await waitFor(2, 2, 2);
    expect(await runtime.runPromise(client.snapshot())).toEqual(before);
    child.kill('SIGTERM');
    await child.exited;
    await expect(runtime.runPromise(ensureServer(connection, false))).rejects.toThrow(
      'pipes server is not running.',
    );
  } finally {
    child?.kill('SIGTERM');
    await child?.exited;
    await runtime.runPromise(Effect.flatMap(Client, (client) => client.shutdown())).catch(() => {});
    await runtime.dispose();
    await rm(directory, { force: true, recursive: true });
  }
}, 20_000);
