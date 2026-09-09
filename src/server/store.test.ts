import { expect, test } from 'bun:test';
import { BunServices } from '@effect/platform-bun';
import { Effect, Layer, ManagedRuntime, Queue, Stream } from 'effect';
import { type Snapshot } from '../protocol/pipes';
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
