import { expect, spyOn, test } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { tmpdir } from 'node:os';
import { act } from 'react';
import { Client } from '../client/connection';
import { PipesError, Repository } from '../protocol/pipes';
import { RepositoryConnection } from './repository-connection';

test('connection UI offers local remotes, signs in, selects workflows, and lists remote repositories', async () => {
  const repository = new Repository({ id: 'repo', name: 'repo', path: tmpdir() });
  const attached: Array<{ path: string; repository: string; workflow: string }> = [];
  const clones: Array<string> = [];
  const identityFails = true;
  let listingFails = true;
  const listing = Promise.withResolvers<void>();
  let authentication = Promise.withResolvers<void>();
  let connected = 0;
  let localOnly = 0;
  let closed = 0;
  const inspection = Promise.withResolvers<void>();
  const identity = Promise.withResolvers<void>();
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
            Effect.promise(() => identity.promise).pipe(
              Effect.flatMap(() =>
                identityFails
                  ? Effect.fail(new PipesError({ message: 'Sign in, then retry.' }))
                  : Effect.succeed('peelar'),
              ),
            ),
          githubInspect: () =>
            Effect.promise(async () => {
              await inspection.promise;
              return { remotes: ['peelar/pipes'], workflows: ['first', 'second'] };
            }),
          githubLoginComplete: () =>
            Effect.promise(() => authentication.promise).pipe(Effect.as('peelar')),
          githubLoginStart: () =>
            Effect.succeed({
              deviceCode: 'device-code',
              interval: 5,
              userCode: 'ABCD-1234',
              verificationUri: 'https://github.com/login/device',
            }),
          githubRepositories: () =>
            Effect.promise(() => listing.promise).pipe(
              Effect.flatMap(() =>
                listingFails
                  ? Effect.fail(new PipesError({ message: 'Sign in to load repositories.' }))
                  : Effect.succeed({ login: 'peelar', repositories: ['another/project'] }),
              ),
            ),
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
    expect(view.captureCharFrame()).toContain('Connecting…');
    expect(view.captureCharFrame()).not.toContain('Check GitHub connection');
    expect(view.captureCharFrame()).not.toContain('Choose a workflow');
    await act(async () => {
      identity.resolve();
      await Bun.sleep(50);
    });
    await view.flush();
    expect(view.captureCharFrame()).toContain('Sign in, then retry.');
    expect(view.captureCharFrame()).toContain('Check GitHub connection');
    expect(attached).toHaveLength(0);
    const loginSpawn = spyOn(Bun, 'spawn').mockReturnValue({
      exited: Promise.resolve(0),
    } as ReturnType<typeof Bun.spawn>);
    await press('RETURN');
    expect(loginSpawn).toHaveBeenCalledWith([
      'open',
      'https://github.com/apps/pipes-github/installations/new',
    ]);
    expect(view.captureCharFrame()).toContain(
      'Choose the GitHub account and repositories Pipes may access.',
    );
    await press('RETURN');
    expect(loginSpawn).toHaveBeenCalledWith(['open', 'https://github.com/login/device']);
    expect(view.captureCharFrame()).toContain('ABCD-1234');
    expect(view.captureCharFrame()).toContain('Waiting for GitHub approval…');
    await act(async () => {
      authentication.resolve();
      await Bun.sleep(50);
    });
    loginSpawn.mockRestore();
    await view.flush();
    expect(view.captureCharFrame()).toContain('Connected to GitHub as @peelar');
    expect(view.captureCharFrame()).not.toContain('Check GitHub connection');
    expect(view.captureCharFrame()).toContain('open issues assigned to you');
    authentication = Promise.withResolvers<void>();
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
    await act(async () => {
      await Bun.sleep(50);
    });
    await view.waitForFrame((frame) => frame.includes('Browse local directories'));
    expect(view.captureCharFrame()).toContain('Clone from GitHub');
    expect(view.captureCharFrame()).not.toContain('Local');
    await press('ARROW_DOWN');
    await press('RETURN');
    expect(view.captureCharFrame()).toContain('Loading GitHub repositories…');
    expect(view.captureCharFrame()).not.toContain('another/project');
    await act(async () => {
      listing.resolve();
      await Bun.sleep(50);
    });
    await view.waitForFrame((frame) => frame.includes('Connect GitHub'));
    const spawn = spyOn(Bun, 'spawn').mockReturnValue({
      exited: Promise.resolve(0),
    } as ReturnType<typeof Bun.spawn>);
    try {
      await press('RETURN');
      expect(spawn).toHaveBeenCalledWith([
        'open',
        'https://github.com/apps/pipes-github/installations/new',
      ]);
      expect(view.captureCharFrame()).toContain(
        'Choose the GitHub account and repositories Pipes may access.',
      );
      await press('RETURN');
      expect(spawn).toHaveBeenCalledWith(['open', 'https://github.com/login/device']);
      expect(view.captureCharFrame()).toContain('ABCD-1234');
      expect(view.captureCharFrame()).toContain('Waiting for GitHub approval…');
      listingFails = false;
      await act(async () => {
        authentication.resolve();
        await Bun.sleep(50);
      });
    } finally {
      spawn.mockRestore();
    }
    await view.waitForFrame((frame) => frame.includes('another/project'));
    expect(view.captureCharFrame()).toContain('[b] back');
    await press('b');
    await act(async () => {
      await Bun.sleep(50);
    });
    await view.waitForFrame((frame) => frame.includes('Browse local directories'));
    await press('ARROW_DOWN');
    await press('RETURN');
    await view.waitForFrame((frame) => frame.includes('another/project'));
    expect(view.captureCharFrame()).toContain('Only connect repositories you trust');
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
