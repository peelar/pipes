import { Effect } from 'effect';
import { ensureServer, settings } from '../client/connection';
import { Client } from '@pipes/protocol';

export const connection = settings();

export const connect = Effect.gen(function* () {
  yield* ensureServer(connection);
  return yield* Client;
});
