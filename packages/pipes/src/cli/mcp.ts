import { Effect } from 'effect';
import { runMcp } from '@pipes/mcp';
import { connect } from './connection';

export const mcp = Effect.fn('mcp')(function* () {
  const client = yield* connect;
  yield* runMcp(client, process.cwd());
});
