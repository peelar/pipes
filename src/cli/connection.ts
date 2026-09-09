import { Effect } from 'effect';
import { Client, ensureServer, settings } from '../client/connection';

export const connection = settings();

export const connect = Effect.gen(function* () {
  yield* ensureServer(connection);
  return yield* Client;
});
