import { expect, test } from 'bun:test';
import { Effect } from 'effect';
import { Repository, Run, Snapshot, Task } from '@pipes/protocol';
import { mcpMessage, type McpClient } from './mcp';

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

test('MCP reports the workflow position along the taken route', async () => {
  const agent = { model: 'codex', provider: 'codex' as const, reasoning: 'high' };
  const routedTask = new Task({
    ...task,
    id: 'routed-task',
    title: 'Route it',
  });
  const routedRun = new Run({
    ...run,
    attempts: [
      {
        id: 'classify-attempt',
        result: { output: 'ui_change', status: 'completed', summary: 'Surface change.' },
        status: 'completed',
        step: 'classify',
        transcript: '/evidence/classify.jsonl',
      },
    ],
    configuration: {
      workflows: {
        routed: {
          steps: [
            {
              agent,
              name: 'classify',
              prompt: 'Classify the change.',
              routes: {
                deep_change: [{ agent, name: 'architect', prompt: 'Rearchitect it.' }],
                ui_change: [{ agent, name: 'implement', prompt: 'Implement it.' }],
              },
            },
          ],
        },
      },
    },
    status: 'running',
    taskId: routedTask.id,
    workflow: 'routed',
  });
  const snapshot = new Snapshot({
    repositories: [repository],
    runs: [routedRun],
    tasks: [routedTask],
    transitions: [],
  });
  const client: McpClient = {
    conversation: () => Effect.succeed(''),
    snapshot: () => Effect.succeed(snapshot),
    start: () => Effect.succeed(routedRun),
    submit: () => Effect.succeed(routedTask),
  };
  const response = (await Effect.runPromise(
    mcpMessage(client, '/code/pipes', {
      id: 1,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: { taskId: routedTask.id }, name: 'task_context' },
    }),
  )) as { result: { content: Array<{ text: string }> } };
  const context = JSON.parse(response.result.content[0]!.text!);
  expect(context.currentStep).toEqual({ agent, name: 'implement', prompt: 'Implement it.' });
  expect(context.workflow[0].routes.ui_change[0].name).toBe('implement');
  expect(context.workflow[0].routes.deep_change[0].name).toBe('architect');
  expect(JSON.stringify(context.attempts)).toContain('ui_change');
});
