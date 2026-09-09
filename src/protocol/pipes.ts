import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import { Agent, AgentCommand } from '../config';

const AgentChoice = Schema.Struct({ name: Schema.String, value: Schema.NonEmptyString });
export class CodexSettings extends Schema.Class<CodexSettings>('CodexSettings')({
  adapter: Schema.String,
  configurationExists: Schema.Boolean,
  model: Schema.NonEmptyString,
  models: Schema.Array(AgentChoice),
  reasoning: Schema.NonEmptyString,
  reasoningOptions: Schema.Array(AgentChoice),
}) {}

export const CodexProbe = Schema.Struct({
  command: Schema.optionalKey(AgentCommand),
  model: Schema.optionalKey(Schema.NonEmptyString),
  path: Schema.NonEmptyString,
  reasoning: Schema.optionalKey(Schema.NonEmptyString),
});

export const Title = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(240));
export const Brief = Schema.String.check(Schema.isMaxLength(100_000));

export class Repository extends Schema.Class<Repository>('Repository')({
  id: Schema.String,
  name: Schema.String,
  path: Schema.String,
}) {}

export class Task extends Schema.Class<Task>('Task')({
  brief: Brief,
  createdAt: Schema.String,
  id: Schema.String,
  repositoryId: Schema.String,
  status: Schema.Literal('queued'),
  title: Title,
}) {}

export class Transition extends Schema.Class<Transition>('Transition')({
  createdAt: Schema.String,
  id: Schema.Int,
  kind: Schema.Literal('submitted'),
  taskId: Schema.String,
}) {}

export class Snapshot extends Schema.Class<Snapshot>('Snapshot')({
  repositories: Schema.Array(Repository),
  tasks: Schema.Array(Task),
  transitions: Schema.Array(Transition),
}) {}

export class PipesError extends Schema.TaggedError<PipesError>()('PipesError', {
  message: Schema.String,
}) {}

export class PipesRpcs extends RpcGroup.make(
  Rpc.make('codexProbe', { error: PipesError, payload: CodexProbe, success: CodexSettings }),
  Rpc.make('codexSetup', {
    error: PipesError,
    payload: { agent: Agent, path: Schema.NonEmptyString },
    success: Schema.String,
  }),
  Rpc.make('configCheck', {
    error: PipesError,
    payload: { path: Schema.NonEmptyString },
    success: Schema.String,
  }),
  Rpc.make('snapshot', { error: PipesError, success: Snapshot }),
  Rpc.make('watch', { error: PipesError, stream: true, success: Snapshot }),
  Rpc.make('register', {
    error: PipesError,
    payload: { path: Schema.NonEmptyString },
    success: Repository,
  }),
  Rpc.make('submit', {
    error: PipesError,
    payload: { brief: Brief, repositoryId: Schema.NonEmptyString, title: Title },
    success: Task,
  }),
  Rpc.make('shutdown', { success: Schema.Void }),
) {}
