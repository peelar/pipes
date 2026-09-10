import { testRender } from '@opentui/react/test-utils';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { tmpdir } from 'node:os';
import { act, type ReactNode } from 'react';
import { Client, type Connection } from '@pipes/protocol';

export type TestView = Awaited<ReturnType<typeof testRender>>;
type PressModifiers = NonNullable<Parameters<TestView['mockInput']['pressKey']>[1]>;

/** Poll until `predicate` passes, mirroring opencode's `wait` fixture helper. */
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  options?: { interval?: number; message?: string; timeout?: number },
): Promise<void> {
  const timeout = options?.timeout ?? 2000;
  const interval = options?.interval ?? 10;
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeout) {
      throw new Error(options?.message ?? 'timed out waiting for condition');
    }
    await Bun.sleep(interval);
  }
}

/**
 * Wait for a frame containing `text`.
 *
 * Unlike `view.waitForFrame`, this keeps flushing on a wall-clock budget, so it
 * also observes state that arrives from outside the renderer (server streams,
 * CLI subprocesses, timers). `view.waitForFrame` stops once the render
 * scheduler goes idle and cannot see those updates.
 */
export async function waitForText(
  view: TestView,
  text: string,
  options?: { interval?: number; timeout?: number },
): Promise<string> {
  let last = '';
  try {
    await waitUntil(
      async () => {
        await view.flush();
        last = view.captureCharFrame();
        return last.includes(text);
      },
      {
        interval: options?.interval ?? 50,
        message: `timed out waiting for ${JSON.stringify(text)}`,
        timeout: options?.timeout ?? 5000,
      },
    );
  } catch (error) {
    throw new Error(`${(error as Error).message}\nlast frame:\n${last}`, { cause: error });
  }
  return last;
}

/** Press one key inside `act`, settle effects, then flush the frame. */
export async function press(
  view: TestView,
  key: string,
  modifiers?: PressModifiers,
): Promise<void> {
  await act(async () => {
    view.mockInput.pressKey(key, modifiers);
    await Bun.sleep(50);
  });
  await view.flush();
}

/** Stub the `Client` RPC service at the boundary; tests own the state. */
export function stubClient(
  overrides: Partial<Client['Service']>,
  connection?: Connection,
): ManagedRuntime.ManagedRuntime<Client, never> {
  return ManagedRuntime.make(
    Layer.effect(
      Client,
      Effect.map(Client, (client) => Client.of({ ...client, ...overrides } as Client['Service'])),
    ).pipe(
      Layer.provide(
        Client.layer(
          connection ?? { directory: tmpdir(), port: 1, token: 'test', url: 'http://127.0.0.1:1' },
        ),
      ),
    ),
  );
}

/** Render a node and always destroy the renderer, even on failure. */
export async function withView(
  node: ReactNode,
  options: { height: number; width: number },
  fn: (view: TestView) => Promise<void>,
): Promise<void> {
  const view = await testRender(node, options);
  try {
    await fn(view);
  } finally {
    await act(async () => {
      view.renderer.destroy();
    });
  }
}
