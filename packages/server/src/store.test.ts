import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { BunServices } from '@effect/platform-bun';
import { Effect, Layer, ManagedRuntime, Queue, Stream } from 'effect';
import { type Snapshot } from '@pipes/protocol';
import { Store } from './store';

test('watch emits initially and after writes, stays idle otherwise, and supports new observers', async () => {
  const runtime = ManagedRuntime.make(
    Store.layer(':memory:').pipe(Layer.provide(BunServices.layer)),
  );
  const updates = await Effect.runPromise(Queue.unbounded<Snapshot>());
  const controller = new AbortController();
  const watching = runtime
    .runPromise(
      Effect.flatMap(Store, (store) =>
        store.watch.pipe(Stream.runForEach((snapshot) => Queue.offer(updates, snapshot))),
      ),
      { signal: controller.signal },
    )
    .catch(() => {});
  const next = () => Effect.runPromise(Queue.take(updates).pipe(Effect.timeout('2 seconds')));
  try {
    expect((await next()).tasks).toHaveLength(0);
    const repository = await runtime.runPromise(
      Effect.flatMap(Store, (store) => store.register(process.cwd())),
    );
    expect((await next()).repositories).toHaveLength(1);
    await runtime.runPromise(
      Effect.flatMap(Store, (store) =>
        store.submit({
          brief: 'Keep this brief.',
          repositoryId: repository.id,
          title: 'Watch me',
        }),
      ),
    );
    expect((await next()).tasks[0]?.brief).toBe('Keep this brief.');
    await Bun.sleep(1100);
    expect(await Effect.runPromise(Queue.size(updates))).toBe(0);
    const latest = await runtime.runPromise(
      Effect.flatMap(Store, (store) =>
        store.watch.pipe(Stream.take(1), Stream.runCollect, Effect.timeout('2 seconds')),
      ),
    );
    expect(latest[0]?.tasks).toHaveLength(1);
  } finally {
    controller.abort();
    await watching;
    await runtime.dispose();
  }
});

test('existing execution databases gain event timestamps without losing runs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pipes-migration-'));
  const filename = join(directory, 'pipes.sqlite');
  const makeRuntime = () =>
    ManagedRuntime.make(Store.layer(filename).pipe(Layer.provide(BunServices.layer)));
  let runtime = makeRuntime();
  try {
    const repository = await runtime.runPromise(
      Effect.flatMap(Store, (store) => store.register(process.cwd())),
    );
    const task = await runtime.runPromise(
      Effect.flatMap(Store, (store) =>
        store.submit({ brief: '', repositoryId: repository.id, title: 'Migration' }),
      ),
    );
    const run = {
      attempts: [],
      baseRevision: 'base',
      branch: 'pipes/test',
      brief: '',
      configuration: {
        workflows: {
          work: {
            steps: [
              {
                agent: { model: 'test', provider: 'codex' as const, reasoning: 'low' },
                name: 'work',
                prompt: 'work',
              },
            ],
          },
        },
      },
      createdAt: '2026-09-09T00:00:00.000Z',
      id: 'migration-run',
      status: 'queued' as const,
      summary: '',
      taskId: task.id,
      title: task.title,
      workflow: 'work',
      workspace: directory,
    };
    await runtime.runPromise(Effect.flatMap(Store, (store) => store.saveRun(run, true)));
    await runtime.dispose();
    const legacy = new Database(filename);
    legacy.exec('ALTER TABLE run_events DROP COLUMN createdAt');
    legacy.exec('ALTER TABLE tasks DROP COLUMN discardedAt');
    legacy.exec('DELETE FROM effect_sql_migrations WHERE migration_id >= 4');
    legacy.close();
    runtime = makeRuntime();
    await runtime.runPromise(
      Effect.flatMap(Store, (store) => store.saveRun({ ...run, summary: 'Upgraded' })),
    );
    expect(
      (await runtime.runPromise(Effect.flatMap(Store, (store) => store.snapshot))).runs?.[0]
        ?.summary,
    ).toBe('Upgraded');
    const upgraded = new Database(filename, { readonly: true });
    try {
      const events = upgraded
        .query<{ createdAt: string }, []>('SELECT createdAt FROM run_events ORDER BY id')
        .all();
      expect(events).toHaveLength(2);
      expect(events[0]?.createdAt).toBe(run.createdAt);
      expect(events[1]?.createdAt).toBeTruthy();
    } finally {
      upgraded.close();
    }
    await runtime.dispose();
    runtime = makeRuntime();
    expect(
      (await runtime.runPromise(Effect.flatMap(Store, (store) => store.snapshot))).runs,
    ).toHaveLength(1);
  } finally {
    await runtime.dispose();
    rmSync(directory, { force: true, recursive: true });
  }
});

test('admission deduplicates source observations independently of delivery and preserves manual tasks', async () => {
  const runtime = ManagedRuntime.make(
    Store.layer(':memory:').pipe(Layer.provide(BunServices.layer)),
  );
  try {
    const store = await runtime.runPromise(Store);
    const repository = await runtime.runPromise(store.register(process.cwd()));
    const request = { brief: 'Original request', repositoryId: repository.id, title: 'Work' };
    const github = await runtime.runPromise(store.submit({ ...request, sourceId: 'github:1' }));
    const linear = await runtime.runPromise(store.submit({ ...request, sourceId: 'linear:1' }));
    const repeated = await Promise.all(
      ['github:1', 'linear:1', 'github:1', 'linear:1'].map((sourceId) =>
        runtime.runPromise(store.submit({ ...request, brief: 'Changed', sourceId })),
      ),
    );
    expect(repeated.map((task) => task.id)).toEqual([github.id, linear.id, github.id, linear.id]);
    expect(repeated.every((task) => task.brief === request.brief)).toBe(true);
    await runtime.runPromise(store.submit(request));
    await runtime.runPromise(store.submit(request));
    await expect(runtime.runPromise(store.submit({ ...request, sourceId: '' }))).rejects.toThrow();
    await expect(
      runtime.runPromise(store.submit({ ...request, repositoryId: 'unregistered' })),
    ).rejects.toThrow('Register the repository');
    const snapshot = await runtime.runPromise(store.snapshot);
    expect(snapshot.tasks).toHaveLength(4);
    expect(snapshot.transitions).toHaveLength(4);
  } finally {
    await runtime.dispose();
  }
});

test('discard removes a task from the queue while preserving its stored history', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pipes-discard-'));
  const filename = join(directory, 'pipes.sqlite');
  const makeRuntime = () =>
    ManagedRuntime.make(Store.layer(filename).pipe(Layer.provide(BunServices.layer)));
  let runtime = makeRuntime();
  try {
    let store = await runtime.runPromise(Store);
    const repository = await runtime.runPromise(store.register(process.cwd()));
    const task = await runtime.runPromise(
      store.submit({ brief: 'Keep me', repositoryId: repository.id, title: 'Discard me' }),
    );
    await runtime.dispose();
    const legacy = new Database(filename);
    legacy.exec(`
      ALTER TABLE transitions RENAME TO transitions_fixed;
      CREATE TABLE transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL REFERENCES tasks(id),
        kind TEXT NOT NULL CHECK(kind = 'submitted'), createdAt TEXT NOT NULL
      );
      INSERT INTO transitions SELECT * FROM transitions_fixed;
      DROP TABLE transitions_fixed;
      DELETE FROM effect_sql_migrations WHERE migration_id >= 6;
    `);
    legacy.close();
    runtime = makeRuntime();
    store = await runtime.runPromise(Store);
    await runtime.runPromise(store.discard(task.id));
    expect((await runtime.runPromise(store.snapshot)).tasks).toHaveLength(0);
    const database = new Database(filename, { readonly: true });
    try {
      expect(database.query('SELECT id FROM tasks WHERE id = ?').get(task.id)).toBeTruthy();
      expect(
        database
          .query<{ kind: string }, [string]>(
            'SELECT kind FROM transitions WHERE taskId = ? ORDER BY id',
          )
          .all(task.id)
          .map(({ kind }) => kind),
      ).toEqual(['submitted', 'discarded']);
    } finally {
      database.close();
    }
  } finally {
    await runtime.dispose();
    rmSync(directory, { force: true, recursive: true });
  }
});
