import { Schema } from 'effect';

const Text = Schema.String.check(Schema.isPattern(/\S/));
const Command = Schema.Array(Schema.String).check(
  Schema.isMinLength(1),
  Schema.makeFilter((command) => /\S/.test(command[0] ?? '') || 'Expected an executable'),
);

export const Agent = Schema.Struct({
  command: Schema.optionalKey(Command),
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
  setup: Schema.optionalKey(Command),
  workflows: Schema.Record(Text, Workflow).check(
    Schema.makeFilter(
      (workflows) => Object.keys(workflows).length > 0 || 'Expected at least one workflow',
    ),
  ),
});

export type Config = typeof Config.Type;

export const decodeConfig = Schema.decodeUnknownEffect(Config, {
  errors: 'all',
  onExcessProperty: 'error',
});
