import { expect, test } from 'bun:test';
import { Effect } from 'effect';
import { Repository, Run, Snapshot, Task } from '@pipes/protocol';
import { mcpMessage } from './mcp';

const repository = new Repository({ id: 'repo', name: 'pipes', path: '/code/pipes' });
const task = new Task({
  brief: 'Fix the thing.',
  createdAt: '2026-09-08T00:00:00.000Z',
  id: 'task',
  repositoryId: repository.id,
  sourceId: 'github:1',
  sourceUrl: 'https://example.com/issues/1',
  status: 'blocked',
  title: 'Fix it',
  workflow: 'rpi',
});
const run = new Run({
  attempts: [
    {
      id: 'attempt',
      result: { status: 'blocked', summary: 'Need a product decision.' },
      status: 'blocked',
      step: 'plan',
      transcript: '/evidence/attempt.jsonl',
    },
  ],
  baseRevision: 'base',
  branch: 'pipes/run',
  brief: task.brief,
  configuration: {
    workflows: {
      rpi: {
        steps: [
          {
            agent: { model: 'codex', provider: 'codex', reasoning: 'high' },
            name: 'plan',
            prompt: 'Plan it.',
          },
        ],
      },
    },
  },
  createdAt: task.createdAt,
  id: 'run',
  status: 'blocked',
  summary: 'Need a product decision.',
  taskId: task.id,
  title: task.title,
  updatedAt: '2026-09-09T00:00:00.000Z',
  workflow: 'rpi',
  workspace: '/worktree',
});

test('MCP surfaces attention context and can submit a detached workflow', async () => {
  const submissions: Array<unknown> = [];
  const starts: Array<unknown> = [];
  const snapshot = new Snapshot({
    repositories: [repository],
    runs: [run],
    tasks: [task],
    transitions: [],
  });
  const client = {
    conversation: () => Effect.succeed('Full conversation'),
    snapshot: () => Effect.succeed(snapshot),
    start: (input: unknown) => Effect.sync(() => (starts.push(input), run)),
    submit: (input: unknown) =>
      Effect.sync(() => {
        submissions.push(input);
        return task;
      }),
  };
  const call = (name: string, arguments_: unknown = {}) =>
    Effect.runPromise(
      mcpMessage(client, '/code/pipes', {
        id: 1,
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { arguments: arguments_, name },
      }),
    );

  expect(JSON.stringify(await call('attention'))).toContain('Need a product decision.');
  expect(
    JSON.stringify(await call('task_context', { includeConversation: true, taskId: task.id })),
  ).toContain('Full conversation');
  expect(JSON.stringify(await call('run_task', { title: 'New work', workflow: 'rpi' }))).toContain(
    'run',
  );
  expect(submissions).toEqual([
    { brief: '', repositoryId: repository.id, title: 'New work', workflow: 'rpi' },
  ]);
  expect(starts).toEqual([{ taskId: task.id, workflow: 'rpi' }]);
});
