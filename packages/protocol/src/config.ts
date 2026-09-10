import { Schema } from 'effect';

const Text = Schema.String.check(Schema.isPattern(/\S/));
export const GitHubRepository = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/),
);
export const GitHubPolicy = Schema.Struct({
  assigned_to_me: Schema.optionalKey(Schema.Boolean),
  repository: GitHubRepository,
  state: Schema.optionalKey(Schema.Literals(['open', 'closed', 'all'])),
  workflow: Text,
});

export function githubRepository(value: string) {
  return Schema.decodeSync(GitHubRepository)(
    value
      .trim()
      .replace(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/i, '')
      .replace(/\/$/, '')
      .replace(/\.git$/, ''),
  );
}
export const AgentCommand = Schema.Array(Schema.String).check(
  Schema.isMinLength(1),
  Schema.makeFilter((command) => /\S/.test(command[0] ?? '') || 'Expected an executable'),
);

export const Agent = Schema.Struct({
  command: Schema.optionalKey(AgentCommand),
  model: Text,
  provider: Schema.Literals(['codex']),
  reasoning: Text,
});

export const Workflow = Schema.Struct({
  steps: Schema.Array(
    Schema.Struct({
      agent: Agent,
      name: Text,
      prompt: Text,
    }),
  ).check(
    Schema.isMinLength(1),
    Schema.makeFilter(
      (steps) =>
        new Set(steps.map((step) => step.name)).size === steps.length ||
        'Step names must be unique within a workflow',
    ),
  ),
});

export const Config = Schema.Struct({
  base: Schema.optionalKey(Text),
  github: Schema.optionalKey(GitHubPolicy),
  setup: Schema.optionalKey(AgentCommand),
  workflows: Schema.Record(Text, Workflow).check(
    Schema.makeFilter(
      (workflows) => Object.keys(workflows).length > 0 || 'Expected at least one workflow',
    ),
  ),
}).check(
  Schema.makeFilter(
    (config) =>
      !config.github ||
      Object.hasOwn(config.workflows, config.github.workflow) ||
      'GitHub workflow must exist',
  ),
);

export type Config = typeof Config.Type;

export const decodeConfig = Schema.decodeUnknownEffect(Config, {
  errors: 'all',
  onExcessProperty: 'error',
});
