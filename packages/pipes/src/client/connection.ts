import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { selfCommand } from '@pipes/server/self';
import { PipesError, requireSupportedBun, type Connection } from '@pipes/protocol';
import { Effect, Schema } from 'effect';

export const settings = () => {
  requireSupportedBun();
  const directory = resolve(
    process.env.PIPES_DATA_DIR ?? join(homedir(), '.local', 'share', 'pipes'),
  );
  const port = Schema.decodeSync(
    Schema.Int.check(Schema.isBetween({ maximum: 65_535, minimum: 1024 })),
  )(Number(process.env.PIPES_PORT ?? 43_187));
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const tokenFile = join(directory, 'token');
  try {
    writeFileSync(tokenFile, crypto.randomUUID(), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!Schema.is(Schema.Struct({ code: Schema.Literal('EEXIST') }))(error)) {
      throw error;
    }
  }
  return {
    directory,
    port,
    token: readFileSync(tokenFile, 'utf8'),
    url: `http://127.0.0.1:${port}`,
  };
};

export const ensureServer = Effect.fn('ensureServer')(function* (
  connection: Connection,
  start = true,
) {
  const ready = Effect.tryPromise({
    catch: (error) => new PipesError({ message: String(error) }),
    try: async () => {
      try {
        const response = await fetch(`${connection.url}/health`, {
          headers: { Authorization: `Bearer ${connection.token}` },
          signal: AbortSignal.timeout(500),
        });
        if (!response.ok || (await response.text()) !== 'pipes/1') {
          throw new Error('Another server is using PIPES_PORT, or its data directory differs.');
        }
        return true;
      } catch (error) {
        if (
          Schema.is(
            Schema.Struct({ code: Schema.Literals(['ECONNREFUSED', 'ConnectionRefused']) }),
          )(error)
        ) {
          return false;
        }
        throw error;
      }
    },
  });
  if (yield* ready) {
    return;
  }
  if (!start) {
    return yield* new PipesError({ message: 'pipes server is not running.' });
  }
  yield* Effect.try({
    catch: (error) => new PipesError({ message: `Cannot start server: ${String(error)}` }),
    try: () => {
      const log = openSync(join(connection.directory, 'server.log'), 'a', 0o600);
      try {
        const { args, executable } = selfCommand(['__server']);
        const child = spawn(executable, args, {
          detached: true,
          env: {
            ...process.env,
            PIPES_DATA_DIR: connection.directory,
            PIPES_PORT: String(connection.port),
          },
          stdio: ['ignore', log, log],
        });
        child.on('error', () => {});
        child.unref();
      } finally {
        closeSync(log);
      }
    },
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    yield* Effect.sleep('100 millis');
    if (yield* ready) {
      return;
    }
  }
  return yield* new PipesError({
    message: `Server did not start. See ${join(connection.directory, 'server.log')}`,
  });
});
