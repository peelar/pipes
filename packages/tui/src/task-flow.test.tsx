import { expect, test } from 'bun:test';
import { Effect, Stream } from 'effect';
import { Client } from '@pipes/protocol';
import { Run, Snapshot } from '@pipes/protocol';
import { App } from './app';
import { press, stubClient, waitForText, withView } from './test-helpers';

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
  const runtime = stubClient(
    {
      cancel: () =>
        Effect.sync(() => {
          events.push('cancel');
          snapshot = new Snapshot({
            ...snapshot,
            runs: snapshot.runs!.map((run) => ({ ...run, status: 'cancelled' })),
            tasks: snapshot.tasks.map((task) => ({ ...task, status: 'cancelled' })),
          });
        }),
      conversation: () => Effect.succeed('Agent\nI checked the implementation.\nTool: bun test'),
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
    } as Partial<Client['Service']>,
    { directory: root, port: 1, token: 'test', url: 'http://127.0.0.1:1' },
  );
  try {
    await withView(
      <App
        onJumpIn={async () => {
          events.push('resume');
        }}
        onQuit={() => events.push('quit')}
        runtime={runtime}
        startDirectory={root}
      />,
      { height: 35, width: 120 },
      async (view) => {
        await waitForText(view, '[s] start');
        expect(view.captureCharFrame()).toContain('[d] discard');
        expect(view.captureCharFrame()).not.toContain('[x] cancel');
        expect(view.captureCharFrame()).not.toContain('[j] jump in');
        await press(view, 's');
        await view.renderOnce();
        expect(view.captureCharFrame()).not.toContain('[s] start');
        expect(view.captureCharFrame()).toContain('[x] cancel');
        expect(view.captureCharFrame()).toContain('[j] jump in');
        await press(view, 's');
        expect(events).toEqual(['start']);
        await press(view, 'v');
        await view.renderOnce();
        expect(view.captureCharFrame()).toContain('I checked the implementation.');
        await press(view, 'x');
        await press(view, 'q');
        expect(events).toEqual(['start']);
        await press(view, 'ESCAPE');
        await press(view, 'j');
        expect(events.pop()).toBe('resume');
        await press(view, 'x');
        await view.renderOnce();
        expect(view.captureCharFrame()).toContain('Cancel task?');
        expect(events).toEqual(['start']);
        await press(view, 'n');
        expect(events).toEqual(['start']);
        await press(view, 'x');
        await press(view, 'y');
        await view.renderOnce();
        expect(events).toEqual(['start', 'cancel']);
        expect(view.captureCharFrame()).toContain('cancelled');
        expect(view.captureCharFrame()).not.toContain('[x] cancel');
        await press(view, 's');
        expect(events).toEqual(['start', 'cancel', 'start']);
        expect(view.captureCharFrame()).toContain('[x] cancel');
        await press(view, 'd');
        await view.renderOnce();
        expect(view.captureCharFrame()).toContain('Discard task?');
        expect(events).toEqual(['start', 'cancel', 'start']);
        await press(view, 'y');
        await view.renderOnce();
        expect(events).toEqual(['start', 'cancel', 'start', 'discard']);
        expect(view.captureCharFrame()).toContain('No tasks yet.');
      },
    );
  } finally {
    await runtime.dispose();
  }
});
