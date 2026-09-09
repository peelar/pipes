import { Console, Effect } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { resolve } from 'node:path';
import { Client, ensureServer } from '../client/connection';
import { Brief, Title } from '../protocol/pipes';
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
    brief: Flag.string('brief').pipe(Flag.withDefault(''), Flag.withSchema(Brief)),
    repo: Flag.string('repo').pipe(Flag.withDescription('Registered repository ID')),
    title: Argument.string('title').pipe(Argument.withSchema(Title)),
  },
  Effect.fn(function* ({ brief, repo, title }) {
    const client = yield* connect;
    yield* Console.log(
      JSON.stringify(yield* client.submit({ brief, repositoryId: repo, title }), null, 2),
    );
  }),
);

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
