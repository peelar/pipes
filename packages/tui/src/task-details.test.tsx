import { expect, test } from 'bun:test';
import { Run, Snapshot, Task } from '@pipes/protocol';
import { TaskDetails } from './app';
import { press, withView } from './test-helpers';

function trackedTask() {
  const task = new Task({
    brief: `${'A long request that wraps across the terminal. '.repeat(15)}\nHidden ending`,
    createdAt: '2026-09-09T10:00:00Z',
    id: 'task-id',
    repositoryId: 'repo',
    status: 'interrupted',
    title: 'Track this task',
  });
  const run = new Run({
    attempts: [
      {
        id: 'attempt',
        result: { status: 'failed', summary: 'Worker stopped.' },
        status: 'interrupted',
        step: 'plan',
        transcript: '/evidence/transcript.jsonl',
      },
    ],
    baseRevision: 'base',
    branch: 'work-branch',
    brief: task.brief,
    configuration: {
      workflows: {
        delivery: {
          steps: [
            {
              agent: { model: 'small', provider: 'codex', reasoning: 'low' },
              name: 'plan',
              prompt: 'Plan.',
            },
          ],
        },
      },
    },
    createdAt: '2026-09-09T11:00:00Z',
    id: 'run-id',
    status: 'interrupted',
    summary: 'Worker stopped.',
    taskId: task.id,
    title: task.title,
    workflow: 'delivery',
    workspace: '/worktree',
  });
  const snapshot = new Snapshot({
    repositories: [],
    runs: [run],
    tasks: [task],
    transitions: [{ createdAt: task.createdAt, id: 1, kind: 'submitted', taskId: task.id }],
  });
  return { run, snapshot, task };
}

test('task tracking leads with state and collapses content and repeated evidence', async () => {
  const { run, snapshot, task } = trackedTask();
  await withView(
    <TaskDetails active repository="pipes" run={run} snapshot={snapshot} task={task} />,
    { height: 45, width: 70 },
    async (view) => {
      await view.flush();
      await view.flush();
      const frame = view.captureCharFrame();
      expect(frame).toContain('Ⅱ plan · interrupted');
      expect(frame).not.toContain('Technical details');
      expect(frame).not.toContain('[d]');
      expect(frame).not.toContain('Hidden ending');
      expect(frame).not.toContain('/evidence');
      expect(frame.match(/Worker stopped\./g)).toHaveLength(1);
      expect(frame.match(/delivery/g)).toHaveLength(1);
      expect(frame).toContain('Description · [b] expand');
      expect(frame).toContain('...');
      expect(frame.match(/Ⅱ plan · interrupted/g)).toHaveLength(1);
      expect(frame.indexOf('delivery')).toBeLessThan(frame.indexOf('Activity'));
      expect(frame.indexOf('Worker stopped.')).toBeLessThan(frame.indexOf('Description'));
      expect(frame.indexOf('Run started')).toBeLessThan(frame.indexOf('submitted'));
      expect(
        frame.split('\n').filter((line) => line.includes('A long request')).length,
      ).toBeLessThanOrEqual(3);
      await press(view, 'b');
      expect(view.captureCharFrame()).toContain('Hidden ending');
      expect(view.captureCharFrame()).toContain('Description · [b] collapse');
      expect(view.captureCharFrame()).not.toContain('...');
      expect(view.captureCharFrame()).not.toContain('/evidence/transcript.jsonl');
      await press(view, 'b');
      expect(view.captureCharFrame()).not.toContain('Hidden ending');
      expect(view.captureCharFrame()).not.toContain('/evidence');
    },
  );
});

test('description ellipsis appears only when content is clipped', async () => {
  for (const brief of ['Short description.', 'One\nTwo\nThree', 'One\nTwo\nThree\nFour']) {
    const task = new Task({
      brief,
      createdAt: '',
      id: 'task',
      repositoryId: 'repo',
      status: 'queued',
      title: 'Task',
    });
    await withView(
      <TaskDetails
        active
        repository="pipes"
        run={undefined}
        snapshot={new Snapshot({ repositories: [], tasks: [task], transitions: [] })}
        task={task}
      />,
      { height: 30, width: 70 },
      async (view) => {
        await view.flush();
        await view.flush();
        expect(view.captureCharFrame().includes('...')).toBe(brief.includes('Four'));
      },
    );
  }
});
