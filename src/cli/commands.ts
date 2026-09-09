import { Console, Effect } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { resolve } from 'node:path';
import { Client, ensureServer } from '../client/connection';
import { Brief, PipesError, Title } from '../protocol/pipes';
import { jumpIn as resumeTask } from '../client/jump-in';
import { connect, connection } from './connection';

export const github = Command.make(
  'github',
  { repo: Flag.string('repo').pipe(Flag.withDescription('Registered repository ID')) },
  Effect.fn(function* ({ repo }) {
    const client = yield* connect;
    const matched = yield* client.githubIntake({ repositoryId: repo });
    yield* Console.log(`Observed ${matched} matching issues; existing tasks were preserved.`);
  }),
);

export const register = Command.make(
  'register',
  { path: Argument.string('path') },
  Effect.fn(function* ({ path }) {
    const client = yield* connect;
    yield* Console.log(JSON.stringify(yield* client.register({ path: resolve(path) }), null, 2));
  }),
);

export const submit = Command.make(
  'submit',
  {
    brief: Flag.string('brief').pipe(
      Flag.withDescription('Markdown task brief'),
      Flag.withDefault(''),
      Flag.withSchema(Brief),
    ),
    repo: Flag.string('repo').pipe(Flag.withDescription('Registered repository ID')),
    title: Argument.string('title').pipe(
      Argument.withDescription('Requested outcome'),
      Argument.withSchema(Title),
    ),
  },
  Effect.fn(function* ({ brief, repo, title }) {
    const client = yield* connect;
    yield* Console.log(
      JSON.stringify(yield* client.submit({ brief, repositoryId: repo, title }), null, 2),
    );
  }),
).pipe(Command.withDescription('Create an ad-hoc task'));

export const list = Command.make(
  'list',
  { json: Flag.boolean('json') },
  Effect.fn(function* ({ json }) {
    const client = yield* connect;
    const snapshot = yield* client.snapshot();
    yield* Console.log(
      json
        ? JSON.stringify(snapshot, null, 2)
        : snapshot.tasks.map((task) => `${task.id}  ${task.status}  ${task.title}`).join('\n') ||
            'No tasks yet.',
    );
  }),
);

export const shutdown = Command.make(
  'shutdown',
  {},
  Effect.fn(function* () {
    yield* ensureServer(connection, false);
    const client = yield* Client;
    yield* client.shutdown();
    yield* Console.log('Pipes server stopped.');
  }),
);

export const start = Command.make(
  'start',
  {
    taskId: Argument.string('task'),
    workflow: Flag.string('workflow').pipe(Flag.withDefault('')),
  },
  Effect.fn(function* ({ taskId, workflow }) {
    const client = yield* connect;
    yield* Console.log(
      JSON.stringify(yield* client.start({ taskId, ...(workflow ? { workflow } : {}) }), null, 2),
    );
  }),
);

export const stop = Command.make(
  'stop',
  { taskId: Argument.string('task') },
  Effect.fn(function* ({ taskId }) {
    const client = yield* connect;
    yield* client.stop({ taskId });
    yield* Console.log('Worker stopped; workspace preserved.');
  }),
);

export const cancel = Command.make(
  'cancel',
  { taskId: Argument.string('task') },
  Effect.fn(function* ({ taskId }) {
    const client = yield* connect;
    yield* client.cancel({ taskId });
    yield* Console.log('Execution cancelled; workspace and evidence preserved.');
  }),
);

export const conversation = Command.make(
  'conversation',
  { taskId: Argument.string('task') },
  Effect.fn(function* ({ taskId }) {
    const client = yield* connect;
    yield* Console.log(yield* client.conversation({ taskId }));
  }),
);

export const jumpIn = Command.make(
  'jump-in',
  {
    confirmedStopped: Flag.boolean('confirm-stopped').pipe(
      Flag.withDescription('Confirm the previous detached worker stopped after a server crash'),
    ),
    taskId: Argument.string('task'),
  },
  Effect.fn(function* ({ confirmedStopped, taskId }) {
    yield* connect;
    yield* resumeTask(taskId, confirmedStopped);
  }),
).pipe(Command.withDescription('Stop detached execution and open the actual Codex resume'));

export const handoffClose = Command.make(
  'handoff-close',
  {
    confirmed: Flag.boolean('confirm-stopped'),
    taskId: Argument.string('task'),
  },
  Effect.fn(function* ({ confirmed, taskId }) {
    if (!confirmed) {
      return yield* new PipesError({
        message:
          'First confirm the interactive Codex process has stopped, then pass --confirm-stopped. This does not stop it for you.',
      });
    }
    const client = yield* connect;
    const run = (yield* client.snapshot()).runs?.findLast((run) => run.taskId === taskId);
    if (!run?.handoffToken) {
      return yield* new PipesError({ message: 'No interactive session lock for this task.' });
    }
    yield* client.handoffClose({ successful: false, taskId, token: run.handoffToken });
    yield* Console.log(
      'Session lock cleared. Task remains human-owned; use jump-in or start explicitly.',
    );
  }),
).pipe(
  Command.withDescription('Recover a crashed interactive client after confirming Codex stopped'),
);
