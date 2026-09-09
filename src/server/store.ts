import { SqliteClient, SqliteMigrator } from '@effect/sql-sqlite-bun';
import { Context, DateTime, Effect, Layer, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { SqlClient } from 'effect/unstable/sql';
import { basename } from 'node:path';
import { PipesError, Repository, Snapshot, Task } from '../protocol/pipes';

const databaseError = () =>
  new PipesError({ message: 'Database operation failed; see server.log.' });

export class Store extends Context.Service<
  Store,
  {
    readonly register: (path: string) => Effect.Effect<Repository, PipesError>;
    readonly snapshot: Effect.Effect<Snapshot, PipesError>;
    readonly submit: (input: {
      brief: string;
      repositoryId: string;
      title: string;
    }) => Effect.Effect<Task, PipesError>;
  }
>()('pipes/Store') {
  static layer = (filename: string) =>
    Layer.effect(
      Store,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        yield* sql`PRAGMA foreign_keys = ON`;
        yield* SqliteMigrator.run({
          loader: SqliteMigrator.fromRecord({
            '0001_queue': Effect.gen(function* () {
              yield* sql`CREATE TABLE repositories (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE)`;
              yield* sql`CREATE TABLE tasks (
          id TEXT PRIMARY KEY, repositoryId TEXT NOT NULL REFERENCES repositories(id),
          title TEXT NOT NULL, brief TEXT NOT NULL, status TEXT NOT NULL CHECK(status = 'queued'), createdAt TEXT NOT NULL
        )`;
              yield* sql`CREATE TABLE transitions (
          id INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL REFERENCES tasks(id),
          kind TEXT NOT NULL CHECK(kind = 'submitted'), createdAt TEXT NOT NULL
        )`;
            }),
          }),
        });

        const snapshot = sql
          .withTransaction(
            Effect.gen(function* () {
              const repositories = yield* sql`SELECT * FROM repositories ORDER BY name, id`;
              const tasks = yield* sql`SELECT * FROM tasks ORDER BY rowid`;
              const transitions = yield* sql`SELECT * FROM transitions ORDER BY id`;
              return yield* Schema.decodeUnknownEffect(Snapshot)({
                repositories,
                tasks,
                transitions,
              });
            }),
          )
          .pipe(Effect.tapError(Effect.logError), Effect.mapError(databaseError));

        const register = Effect.fn('Store.register')(function* (path: string) {
          const root = yield* spawner
            .string(ChildProcess.make('git', ['-C', path, 'rev-parse', '--show-toplevel']))
            .pipe(
              Effect.map((value) => value.trim()),
              Effect.mapError(
                () => new PipesError({ message: `Cannot open Git repository: ${path}` }),
              ),
            );
          if (!root) {
            return yield* new PipesError({ message: `Not a working Git repository: ${path}` });
          }
          const repository = new Repository({
            id: crypto.randomUUID(),
            name: basename(root),
            path: root,
          });
          const rows = yield* sql`INSERT INTO repositories ${sql.insert({ ...repository })}
        ON CONFLICT(path) DO UPDATE SET path = excluded.path RETURNING *`.pipe(
            Effect.mapError(databaseError),
          );
          return yield* Schema.decodeUnknownEffect(Repository)(rows[0]).pipe(
            Effect.mapError(databaseError),
          );
        });

        const submit = Effect.fn('Store.submit')(function* (input: {
          brief: string;
          repositoryId: string;
          title: string;
        }) {
          const task = yield* Schema.decodeEffect(Task)({
            ...input,
            createdAt: DateTime.formatIso(yield* DateTime.now),
            id: crypto.randomUUID(),
            status: 'queued',
          }).pipe(Effect.mapError((error) => new PipesError({ message: error.message })));
          return yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const repositories =
                  yield* sql`SELECT id FROM repositories WHERE id = ${input.repositoryId}`;
                if (repositories.length === 0) {
                  return yield* new PipesError({
                    message: 'Register the repository before submitting a task.',
                  });
                }
                yield* sql`INSERT INTO tasks ${sql.insert({ ...task })}`;
                yield* sql`INSERT INTO transitions ${sql.insert({ createdAt: task.createdAt, kind: 'submitted', taskId: task.id })}`;
                return task;
              }),
            )
            .pipe(
              Effect.catchTag('SqlError', (error) =>
                Effect.logError(error).pipe(Effect.andThen(databaseError())),
              ),
            );
        });

        return Store.of({ register, snapshot, submit });
      }),
    ).pipe(Layer.provide(SqliteClient.layer({ filename })));
}
