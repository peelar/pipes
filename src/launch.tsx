import { createCliRenderer } from '@opentui/core';
import { BunServices } from '@effect/platform-bun';
import { createRoot } from '@opentui/react';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { App, claimWelcome, Welcome } from '@pipes/tui';
import { Client, type Connection } from '@pipes/protocol';
import { jumpIn } from './client/jump-in';
import { ObservabilityLayer } from './observability';

const makeRuntime = (connection: Connection) =>
  ManagedRuntime.make(Client.layer(connection).pipe(Layer.provide(ObservabilityLayer)));

export async function launch(connection: Connection, signal?: AbortSignal) {
  const runtime = makeRuntime(connection);
  const { promise: closed, resolve: finish } = Promise.withResolvers<void>();
  const renderer = await createCliRenderer({ exitOnCtrlC: true, onDestroy: () => finish() });
  const abort = () => renderer.destroy();
  signal?.addEventListener('abort', abort, { once: true });
  const root = createRoot(renderer);
  const firstLaunch = claimWelcome(connection.directory);
  try {
    if (signal?.aborted) {
      return;
    }
    root.render(
      <Welcome firstLaunch={firstLaunch}>
        <App
          onboardingDirectory={connection.directory}
          onJumpIn={async (taskId) => {
            renderer.suspend();
            try {
              await runtime.runPromise(jumpIn(taskId).pipe(Effect.provide(BunServices.layer)));
            } finally {
              renderer.resume();
            }
          }}
          onQuit={() => renderer.destroy()}
          runtime={runtime}
        />
      </Welcome>,
    );
    await closed;
  } finally {
    signal?.removeEventListener('abort', abort);
    root.unmount();
    renderer.destroy();
    await runtime.dispose();
  }
}
