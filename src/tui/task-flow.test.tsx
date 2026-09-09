import { expect, test } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import { Effect, Layer, ManagedRuntime, Stream } from 'effect';
import { act } from 'react';
import { Client } from '../client/connection';
import { Run, Snapshot } from '../protocol/pipes';
import { App } from './app';

test('selected task actions follow execution state and inspection captures keyboard input', async () => {
  const root = process.cwd();
  let snapshot = new Snapshot({
    repositories: [{ id: 'repo', name: 'Project', path: root }],
    runs: [],
    tasks: [
      {
        brief: 'Do work',
        createdAt: '',
        id: 'task',
        repositoryId: 'repo',
        status: 'queued',
        title: 'A task',
      },
    ],
    transitions: [],
  });
  const events: Array<string> = [];
  const runtime = ManagedRuntime.make(
    Layer.effect(
      Client,
      Effect.map(Client, (client) =>
        Client.of({
          ...client,
          cancel: () =>
            Effect.sync(() => {
              events.push('cancel');
              snapshot = new Snapshot({
                ...snapshot,
                runs: snapshot.runs!.map((run) => ({ ...run, status: 'cancelled' })),
                tasks: snapshot.tasks.map((task) => ({ ...task, status: 'cancelled' })),
              });
            }),
          conversation: () =>
            Effect.succeed('Agent\nI checked the implementation.\nTool: bun test'),
          discard: () =>
            Effect.sync(() => {
              events.push('discard');
              snapshot = new Snapshot({ ...snapshot, runs: [], tasks: [], transitions: [] });
            }),
          snapshot: () => Effect.sync(() => snapshot),
          start: () =>
            Effect.sync(() => {
              events.push('start');
              const run = new Run({
                attempts: [],
                baseRevision: 'base',
                branch: 'pipes/run',
                brief: 'Do work',
                configuration: {
                  workflows: {
                    work: {
                      steps: [
                        {
                          agent: { model: 'test', provider: 'codex', reasoning: 'low' },
                          name: 'work',
                          prompt: 'Do work',
                        },
                      ],
                    },
                  },
                },
                createdAt: '',
                id: 'run',
                status: 'running',
                summary: '',
                taskId: 'task',
                title: 'A task',
                workflow: 'work',
                workspace: root,
              });
              snapshot = new Snapshot({
                ...snapshot,
                runs: [run],
                tasks: snapshot.tasks.map((task) => ({ ...task, status: run.status })),
              });
              return run;
            }),
          watch: () => Stream.make(snapshot),
        } as Client['Service']),
      ),
    ).pipe(
      Layer.provide(
        Client.layer({ directory: root, port: 1, token: 'test', url: 'http://127.0.0.1:1' }),
      ),
    ),
  );
  const view = await testRender(
    <App
      onJumpIn={async () => {
        events.push('resume');
      }}
      onQuit={() => events.push('quit')}
      runtime={runtime}
      startDirectory={root}
    />,
    { height: 35, width: 120 },
  );
  const press = async (key: string) =>
    act(async () => {
      view.mockInput.pressKey(key);
      await Bun.sleep(40);
    });
  try {
    await act(async () => {
      await Bun.sleep(50);
    });
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain('[s] start');
    expect(view.captureCharFrame()).toContain('[d] discard');
    expect(view.captureCharFrame()).not.toContain('[x] cancel');
    expect(view.captureCharFrame()).not.toContain('[j] jump in');
    await press('s');
    await view.renderOnce();
    expect(view.captureCharFrame()).not.toContain('[s] start');
    expect(view.captureCharFrame()).toContain('[x] cancel');
    expect(view.captureCharFrame()).toContain('[j] jump in');
    await press('s');
    expect(events).toEqual(['start']);
    await press('v');
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain('I checked the implementation.');
    await press('x');
    await press('q');
    expect(events).toEqual(['start']);
    await press('ESCAPE');
    await press('j');
    expect(events.pop()).toBe('resume');
    await press('x');
    await view.renderOnce();
    expect(events).toEqual(['start', 'cancel']);
    expect(view.captureCharFrame()).toContain('cancelled');
    expect(view.captureCharFrame()).not.toContain('[x] cancel');
    await press('s');
    expect(events).toEqual(['start', 'cancel']);
    await press('d');
    await view.renderOnce();
    expect(events).toEqual(['start', 'cancel', 'discard']);
    expect(view.captureCharFrame()).toContain('No tasks yet.');
  } finally {
    await act(async () => view.renderer.destroy());
    await runtime.dispose();
  }
});
