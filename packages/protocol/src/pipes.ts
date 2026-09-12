import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import { Agent, AgentCommand, Config, GitHubPolicy, GitHubRepository, type Step } from './config';
import { ExecutionStatus } from './execution-state';

export const GitHubConnection = Schema.Struct({
  policy: Schema.optionalKey(GitHubPolicy),
  remotes: Schema.Array(GitHubRepository),
  workflows: Schema.Array(Schema.String),
});

export const GitHubLogin = Schema.Struct({
  deviceCode: Schema.NonEmptyString,
  interval: Schema.Int,
  userCode: Schema.NonEmptyString,
  verificationUri: Schema.NonEmptyString,
});

const AgentChoice = Schema.Struct({ name: Schema.String, value: Schema.NonEmptyString });
export class CodexSettings extends Schema.Class<CodexSettings>('CodexSettings')({
  adapter: Schema.String,
  configurationExists: Schema.Boolean,
  mcpInstalled: Schema.Boolean,
  model: Schema.NonEmptyString,
  models: Schema.Array(AgentChoice),
  reasoning: Schema.NonEmptyString,
  reasoningOptions: Schema.Array(AgentChoice),
  skillInstalled: Schema.Boolean,
}) {}

export const CodexProbe = Schema.Struct({
  command: Schema.optionalKey(AgentCommand),
  model: Schema.optionalKey(Schema.NonEmptyString),
  path: Schema.NonEmptyString,
  reasoning: Schema.optionalKey(Schema.NonEmptyString),
});

export const Title = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(240));
export const Brief = Schema.String.check(Schema.isMaxLength(100_000));

export const TaskSubmission = Schema.Struct({
  brief: Brief,
  repositoryId: Schema.NonEmptyString,
  sourceId: Schema.optionalKey(Schema.NonEmptyString),
  sourceUrl: Schema.optionalKey(Schema.NonEmptyString),
  title: Title,
  workflow: Schema.optionalKey(Schema.NonEmptyString),
});

export type TaskSubmission = typeof TaskSubmission.Type;

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
  sourceId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  sourceUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
  status: ExecutionStatus,
  title: Title,
  workflow: Schema.optionalKey(Schema.NullOr(Schema.String)),
}) {}

export class Transition extends Schema.Class<Transition>('Transition')({
  createdAt: Schema.String,
  id: Schema.Int,
  kind: Schema.Literals(['submitted', 'discarded']),
  taskId: Schema.String,
}) {}

export const StepResult = Schema.Struct({
  // Present only when the assignment's step defines routes: the single named output
  // that selects which continuation chain runs next.
  output: Schema.optionalKey(Schema.NonEmptyString),
  status: Schema.Literals(['completed', 'blocked', 'failed']),
  summary: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(100_000)),
});

// Returns an error message when a reported result does not satisfy the step's routing contract.
export function validateStepResult(
  step: Step | undefined,
  result: typeof StepResult.Type,
): string | undefined {
  const outputs = step?.routes ? Object.keys(step.routes) : [];
  if (outputs.length > 0) {
    if (result.status !== 'completed') {
      return result.output
        ? `Step ${step!.name} cannot report an output with ${result.status}.`
        : undefined;
    }
    if (!result.output) {
      return `Step ${step!.name} must report exactly one output: ${outputs.join(' | ')}.`;
    }
    return outputs.includes(result.output)
      ? undefined
      : `Step ${step!.name} output must be one of: ${outputs.join(' | ')}.`;
  }
  return result.output
    ? step
      ? `Step ${step.name} does not accept an output.`
      : 'This step does not accept an output.'
    : undefined;
}

export const Attempt = Schema.Struct({
  codexHome: Schema.optionalKey(Schema.String),
  id: Schema.String,
  result: Schema.optionalKey(StepResult),
  sessionId: Schema.optionalKey(Schema.String),
  status: Schema.Literals(['running', 'completed', 'blocked', 'failed', 'interrupted']),
  step: Schema.String,
  transcript: Schema.String,
});

export class Run extends Schema.Class<Run>('Run')({
  attempts: Schema.Array(Attempt),
  baseRevision: Schema.String,
  branch: Schema.String,
  brief: Brief,
  configuration: Config,
  createdAt: Schema.String,
  handoffToken: Schema.optionalKey(Schema.String),
  id: Schema.String,
  revision: Schema.optionalKey(Schema.String),
  status: ExecutionStatus,
  summary: Schema.String,
  taskId: Schema.String,
  title: Title,
  updatedAt: Schema.optionalKey(Schema.String),
  workerStopped: Schema.optionalKey(Schema.Boolean),
  workflow: Schema.String,
  workspace: Schema.String,
}) {}

export class Snapshot extends Schema.Class<Snapshot>('Snapshot')({
  repositories: Schema.Array(Repository),
  runs: Schema.optionalKey(Schema.Array(Run)),
  tasks: Schema.Array(Task),
  transitions: Schema.Array(Transition),
}) {}

export class PipesError extends Schema.TaggedError<PipesError>()('PipesError', {
  message: Schema.String,
}) {}

export class PipesRpcs extends RpcGroup.make(
  Rpc.make('githubLoginStart', { error: PipesError, success: GitHubLogin }),
  Rpc.make('githubLoginComplete', {
    error: PipesError,
    payload: { deviceCode: Schema.NonEmptyString, interval: Schema.Int },
    success: Schema.String,
  }),
  Rpc.make('githubRepositories', {
    error: PipesError,
    success: Schema.Struct({ login: Schema.String, repositories: Schema.Array(GitHubRepository) }),
  }),
  Rpc.make('githubIdentity', { error: PipesError, success: Schema.String }),
  Rpc.make('githubInspect', {
    error: PipesError,
    payload: { path: Schema.NonEmptyString },
    success: GitHubConnection,
  }),
  Rpc.make('githubClone', {
    error: PipesError,
    payload: { repository: GitHubRepository },
    success: Schema.String,
  }),
  Rpc.make('githubAttach', {
    error: PipesError,
    payload: {
      path: Schema.NonEmptyString,
      repository: GitHubRepository,
      workflow: Schema.NonEmptyString,
    },
    success: Repository,
  }),
  Rpc.make('githubIntake', {
    error: PipesError,
    payload: { repositoryId: Schema.NonEmptyString },
    success: Schema.Int,
  }),
  Rpc.make('codexProbe', { error: PipesError, payload: CodexProbe, success: CodexSettings }),
  Rpc.make('codexInstall', { error: PipesError, success: Schema.String }),
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
  Rpc.make('start', {
    error: PipesError,
    payload: { taskId: Schema.NonEmptyString, workflow: Schema.optionalKey(Schema.NonEmptyString) },
    success: Run,
  }),
  Rpc.make('stop', {
    error: PipesError,
    payload: { taskId: Schema.NonEmptyString },
    success: Schema.Void,
  }),
  Rpc.make('cancel', {
    error: PipesError,
    payload: { taskId: Schema.NonEmptyString },
    success: Schema.Void,
  }),
  Rpc.make('discard', {
    error: PipesError,
    payload: { taskId: Schema.NonEmptyString },
    success: Schema.Void,
  }),
  Rpc.make('conversation', {
    error: PipesError,
    payload: { taskId: Schema.NonEmptyString },
    success: Schema.String,
  }),
  Rpc.make('jumpIn', {
    error: PipesError,
    payload: {
      confirmedStopped: Schema.optionalKey(Schema.Boolean),
      taskId: Schema.NonEmptyString,
    },
    success: Run,
  }),
  Rpc.make('handoffReport', {
    error: PipesError,
    payload: { result: StepResult, taskId: Schema.NonEmptyString, token: Schema.NonEmptyString },
    success: Schema.Void,
  }),
  Rpc.make('handoffClose', {
    error: PipesError,
    payload: {
      successful: Schema.Boolean,
      taskId: Schema.NonEmptyString,
      token: Schema.NonEmptyString,
    },
    success: Schema.Void,
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
    payload: {
      brief: Brief,
      repositoryId: Schema.NonEmptyString,
      title: Title,
      workflow: Schema.optionalKey(Schema.NonEmptyString),
    },
    success: Task,
  }),
  Rpc.make('shutdown', { success: Schema.Void }),
) {}
