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

export interface Step {
  readonly agent: typeof Agent.Type;
  readonly name: string;
  readonly prompt: string;
  // Routing: the final step of a chain maps each named output to a continuation chain.
  // An empty chain ends the workflow at this decision.
  readonly routes?: { readonly [output: string]: ReadonlyArray<Step> };
}

export const Step: Schema.Codec<Step> = Schema.Struct({
  agent: Agent,
  name: Text,
  prompt: Text,
  routes: Schema.optionalKey(
    Schema.Record(Text, Schema.Array(Schema.suspend((): Schema.Codec<Step> => Step))).check(
      Schema.makeFilter(
        (routes) => Object.keys(routes).length > 0 || 'Expected at least one route',
      ),
    ),
  ),
});

export function* walkChains(steps: ReadonlyArray<Step>): Generator<ReadonlyArray<Step>> {
  yield steps;
  for (const step of steps) {
    if (step.routes) {
      for (const chain of Object.values(step.routes)) {
        yield* walkChains(chain);
      }
    }
  }
}

export function* walkSteps(steps: ReadonlyArray<Step>): Generator<Step> {
  for (const step of steps) {
    yield step;
    if (step.routes) {
      for (const chain of Object.values(step.routes)) {
        yield* walkSteps(chain);
      }
    }
  }
}

export function findStep(steps: ReadonlyArray<Step> | undefined, name: string) {
  for (const step of walkSteps(steps ?? [])) {
    if (step.name === name) {
      return step;
    }
  }
}

// The active path of a run: chain steps in order, descending into the branch each
// completed routing step selected. Stops at a routing step without a recorded decision.
export interface WorkflowPosition {
  decision?: string;
  step: Step;
}

export function workflowPath(
  steps: ReadonlyArray<Step> | undefined,
  attempts: ReadonlyArray<{
    result?: { output?: string; status?: string; summary?: string } | undefined;
    status: string;
    step: string;
  }>,
): Array<WorkflowPosition> {
  const positions: Array<WorkflowPosition> = [];
  const walk = (chain: ReadonlyArray<Step>) => {
    for (const step of chain) {
      if (!step.routes) {
        positions.push({ step });
        continue;
      }
      const attempt = attempts.findLast((attempt) => attempt.step === step.name);
      const decision = attempt?.status === 'completed' ? attempt.result?.output : undefined;
      positions.push(decision ? { decision, step } : { step });
      walk(step.routes[decision!] ?? []);
      return; // A routing step is always the final step of its chain.
    }
  };
  walk(steps ?? []);
  return positions;
}

const WorkflowSteps = Schema.Array(Step).check(
  Schema.isMinLength(1),
  Schema.makeFilter((steps) => {
    const names = new Set<string>();
    for (const step of walkSteps(steps)) {
      if (names.has(step.name)) {
        return 'Step names must be unique within a workflow';
      }
      names.add(step.name);
    }
    for (const chain of walkChains(steps)) {
      if (chain.slice(0, -1).some((step) => step.routes)) {
        return 'Only the final step of a chain may define routes';
      }
    }
    return true;
  }),
);

export const Workflow = Schema.Struct({
  steps: WorkflowSteps,
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
