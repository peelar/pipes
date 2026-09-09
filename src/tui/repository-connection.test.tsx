import { expect, test } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { tmpdir } from 'node:os';
import { act } from 'react';
import { Client } from '../client/connection';
import { PipesError, Repository } from '../protocol/pipes';
import { RepositoryConnection } from './repository-connection';

test('connection UI offers local remotes, retries identity, selects workflows, and accepts arbitrary GitHub URLs', async () => {
  const repository = new Repository({ id: 'repo', name: 'repo', path: tmpdir() });
  const attached: Array<{ path: string; repository: string; workflow: string }> = [];
  const clones: Array<string> = [];
  let identityFails = true;
  let connected = 0;
  let localOnly = 0;
  let closed = 0;
  const inspection = Promise.withResolvers<void>();
  const runtime = ManagedRuntime.make(
    Layer.effect(
      Client,
      Effect.map(Client, (client) =>
        Client.of({
          ...client,
          githubAttach: (input) =>
            Effect.sync(() => {
              attached.push(input);
              return repository;
            }),
          githubClone: (input) =>
            Effect.sync(() => {
              clones.push(input.repository);
              return tmpdir();
            }),
          githubIdentity: () =>
            identityFails
              ? Effect.fail(new PipesError({ message: 'Sign in, then retry.' }))
              : Effect.succeed('peelar'),
          githubInspect: () =>
            Effect.promise(async () => {
              await inspection.promise;
              return { remotes: ['peelar/pipes'], workflows: ['first', 'second'] };
            }),
          register: () =>
            Effect.sync(() => {
              localOnly++;
              return repository;
            }),
        } as Client['Service']),
      ),
    ).pipe(
      Layer.provide(
        Client.layer({ directory: tmpdir(), port: 1, token: 'test', url: 'http://127.0.0.1:1' }),
      ),
    ),
  );
  const render = (initialPath?: string) =>
    testRender(
      <RepositoryConnection
        initialPath={initialPath}
        onClose={() => {
          closed++;
        }}
        onConnected={() => {
          connected++;
        }}
        runtime={runtime}
        startDirectory={tmpdir()}
      />,
      { height: 30, width: 110 },
    );
  let view = await render(tmpdir());
  const press = async (key: string) => {
    await act(async () => {
      view.mockInput.pressKey(key);
      await Bun.sleep(50);
    });
    await view.flush();
  };
  const destroy = () =>
    act(async () => {
      view.renderer.destroy();
    });
  try {
    await view.waitForFrame((frame) => frame.includes('Connecting…'));
    expect(view.captureCharFrame()).not.toContain('Local only');
    expect(view.captureCharFrame()).not.toContain('Attach GitHub issue intake');
    await press('RETURN');
    expect(localOnly).toBe(0);
    await act(async () => {
      inspection.resolve();
      await Bun.sleep(50);
    });
    await view.waitForFrame((frame) => frame.includes('peelar/pipes'));
    expect(view.captureCharFrame()).toContain('Local only');
    await press('RETURN');
    expect(view.captureCharFrame()).toContain('Sign in, then retry.');
    expect(attached).toHaveLength(0);
    identityFails = false;
    await press('RETURN');
    expect(view.captureCharFrame()).toContain('Connected to GitHub as @peelar');
    expect(view.captureCharFrame()).toContain('open issues assigned to you');
    await press('ARROW_DOWN');
    await press('RETURN');
    expect(attached).toEqual([{ path: tmpdir(), repository: 'peelar/pipes', workflow: 'second' }]);
    expect(connected).toBe(1);
    await destroy();
    view = await render(tmpdir());
    await act(async () => {
      await Bun.sleep(50);
    });
    await press('ARROW_DOWN');
    await press('RETURN');
    expect(localOnly).toBe(1);
    expect(attached).toHaveLength(1);
    await destroy();
    view = await render();
    await press('g');
    expect(view.captureCharFrame()).toContain('Only connect repositories you trust');
    await act(async () => {
      await view.mockInput.typeText('https://github.com/another/project.git');
    });
    await press('RETURN');
    expect(clones).toEqual(['another/project']);
    expect(view.captureCharFrame()).toContain('another/project');
    await press('RETURN');
    expect(attached[1]).toEqual({
      path: tmpdir(),
      repository: 'another/project',
      workflow: 'first',
    });
    await press('ESCAPE');
    expect(closed).toBe(1);
  } finally {
    await destroy();
    await runtime.dispose();
  }
});
