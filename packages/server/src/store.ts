import { SqliteClient, SqliteMigrator } from '@effect/sql-sqlite-bun';
import { Context, DateTime, Effect, Layer, PubSub, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { SqlClient } from 'effect/unstable/sql';
import { basename, dirname } from 'node:path';
import { PipesError, Repository, Run, Snapshot, Task, TaskSubmission } from '@pipes/protocol';

const databaseError = () =>
  new PipesError({ message: 'Database operation failed; see server.log.' });

export class Store extends Context.Service<
  Store,
  {
    readonly dataDirectory: string;
    readonly discard: (taskId: string) => Effect.Effect<void, PipesError>;
    readonly register: (path: string) => Effect.Effect<Repository, PipesError>;
    readonly saveRun: (run: Run, create?: boolean) => Effect.Effect<void, PipesError>;
    readonly snapshot: Effect.Effect<Snapshot, PipesError>;
    readonly submit: (input: TaskSubmission) => Effect.Effect<Task, PipesError>;
    readonly watch: Stream.Stream<Snapshot, PipesError>;
  }
>()('pipes/Store') {
  static layer = (filename: string) =>
    Layer.effect(
      Store,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const changes = yield* PubSub.sliding<void>({ capacity: 1, replay: 1 });
        yield* Effect.addFinalizer(() => PubSub.shutdown(changes));
        yield* PubSub.publish(changes, undefined);
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
            '0002_sources': Effect.gen(function* () {
              yield* sql`ALTER TABLE tasks ADD COLUMN sourceId TEXT`;
              yield* sql`ALTER TABLE tasks ADD COLUMN sourceUrl TEXT`;
              yield* sql`ALTER TABLE tasks ADD COLUMN workflow TEXT`;
              yield* sql`CREATE UNIQUE INDEX tasks_source ON tasks(sourceId) WHERE sourceId IS NOT NULL`;
            }),
            '0003_execution': Effect.gen(function* () {
              yield* sql`CREATE TABLE runs (id TEXT PRIMARY KEY, taskId TEXT NOT NULL UNIQUE REFERENCES tasks(id), data TEXT NOT NULL)`;
              yield* sql`CREATE TABLE run_events (id INTEGER PRIMARY KEY AUTOINCREMENT, runId TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL)`;
            }),
            '0004_run_event_timestamps': Effect.gen(function* () {
              const columns = yield* sql<{ name: string }>`PRAGMA table_info(run_events)`;
              if (!columns.some((column) => column.name === 'createdAt')) {
                yield* sql`ALTER TABLE run_events ADD COLUMN createdAt TEXT NOT NULL DEFAULT ''`;
                yield* sql`UPDATE run_events SET createdAt = json_extract(data, '$.createdAt')`;
              }
            }),
            '0005_discarded_tasks': sql`ALTER TABLE tasks ADD COLUMN discardedAt TEXT`,
            '0006_discard_transitions': Effect.gen(function* () {
              yield* sql`ALTER TABLE transitions RENAME TO transitions_old`;
              yield* sql`CREATE TABLE transitions (
                id INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL REFERENCES tasks(id),
                kind TEXT NOT NULL CHECK(kind IN ('submitted', 'discarded')), createdAt TEXT NOT NULL
              )`;
              yield* sql`INSERT INTO transitions SELECT * FROM transitions_old`;
              yield* sql`DROP TABLE transitions_old`;
            }),
            '0007_successive_runs': Effect.gen(function* () {
              yield* sql`CREATE TABLE runs_new (id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id), data TEXT NOT NULL)`;
              yield* sql`CREATE TABLE run_events_new (id INTEGER PRIMARY KEY AUTOINCREMENT, runId TEXT NOT NULL REFERENCES runs_new(id), data TEXT NOT NULL, createdAt TEXT NOT NULL DEFAULT '')`;
              yield* sql`INSERT INTO runs_new SELECT * FROM runs`;
              yield* sql`INSERT INTO run_events_new SELECT * FROM run_events`;
              yield* sql`DROP TABLE run_events`;
              yield* sql`DROP TABLE runs`;
              yield* sql`ALTER TABLE runs_new RENAME TO runs`;
              yield* sql`ALTER TABLE run_events_new RENAME TO run_events`;
            }),
          }),
        });

        const snapshot = sql
          .withTransaction(
            Effect.gen(function* () {
              const repositories = yield* sql`SELECT * FROM repositories ORDER BY name, id`;
              const tasks =
                yield* sql`SELECT * FROM tasks WHERE discardedAt IS NULL ORDER BY rowid`;
              const rows = yield* sql<{
                data: string;
              }>`SELECT runs.data FROM runs JOIN tasks ON tasks.id = runs.taskId WHERE tasks.discardedAt IS NULL ORDER BY runs.rowid`;
              const runs = yield* Effect.forEach(rows, (row) =>
                Schema.decodeEffect(Schema.fromJsonString(Run))(row.data),
              );
              const transitions =
                yield* sql`SELECT transitions.* FROM transitions JOIN tasks ON tasks.id = transitions.taskId WHERE tasks.discardedAt IS NULL ORDER BY transitions.id`;
              return yield* Schema.decodeUnknownEffect(Snapshot)({
                repositories,
                runs,
                tasks: tasks.map((task) => ({
                  ...task,
                  status: runs.findLast((run) => run.taskId === task.id)?.status ?? task.status,
                })),
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

        const discard = Effect.fn('Store.discard')(function* (taskId: string) {
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const rows =
                  yield* sql`UPDATE tasks SET discardedAt = ${createdAt} WHERE id = ${taskId} AND discardedAt IS NULL RETURNING id`;
                if (!rows.length) {
                  return yield* new PipesError({ message: 'Queue item not found.' });
                }
                yield* sql`INSERT INTO transitions ${sql.insert({ createdAt, kind: 'discarded', taskId })}`;
              }),
            )
            .pipe(
              Effect.tapError(Effect.logError),
              Effect.mapError((error) => (error instanceof PipesError ? error : databaseError())),
            );
          yield* PubSub.publish(changes, undefined);
        });

        const submit = Effect.fn('Store.submit')(function* (submission: TaskSubmission) {
          const input = yield* Schema.decodeEffect(TaskSubmission)(submission).pipe(
            Effect.mapError((error) => new PipesError({ message: error.message })),
          );
          const task = yield* Schema.decodeEffect(Task)({
            ...input,
            createdAt: DateTime.formatIso(yield* DateTime.now),
            id: crypto.randomUUID(),
            status: 'queued',
          }).pipe(Effect.mapError((error) => new PipesError({ message: error.message })));
          return yield* sql
            .withTransaction(
              Effect.gen(function* () {
                if (input.sourceId) {
                  const existing =
                    yield* sql`SELECT * FROM tasks WHERE sourceId = ${input.sourceId}`;
                  if (existing.length) {
                    return yield* Schema.decodeUnknownEffect(Task)(existing[0]).pipe(
                      Effect.mapError(databaseError),
                    );
                  }
                }
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

        const saveRun = Effect.fn('Store.saveRun')(function* (input: Run, create = false) {
          const updatedAt = DateTime.formatIso(yield* DateTime.now);
          const run = yield* Schema.decodeEffect(Run)({ ...input, updatedAt }).pipe(
            Effect.mapError(databaseError),
          );
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const data = JSON.stringify(run);
                if (create) {
                  yield* sql`INSERT INTO runs ${sql.insert({ data, id: run.id, taskId: run.taskId })}`;
                } else {
                  yield* sql`UPDATE runs SET data = ${data} WHERE id = ${run.id}`;
                }
                yield* sql`INSERT INTO run_events ${sql.insert({ createdAt: updatedAt, data, runId: run.id })}`;
              }),
            )
            .pipe(Effect.tapError(Effect.logError), Effect.mapError(databaseError));
          yield* PubSub.publish(changes, undefined);
        });

        return Store.of({
          dataDirectory: dirname(filename),
          discard,
          register: (path) =>
            register(path).pipe(Effect.tap(() => PubSub.publish(changes, undefined))),
          saveRun,
          snapshot,
          submit: (input) =>
            submit(input).pipe(Effect.tap(() => PubSub.publish(changes, undefined))),
          watch: Stream.fromPubSub(changes).pipe(Stream.mapEffect(() => snapshot)),
        });
      }),
    ).pipe(Layer.provide(SqliteClient.layer({ filename })));
}
