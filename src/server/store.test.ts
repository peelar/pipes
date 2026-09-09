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
