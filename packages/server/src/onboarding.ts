import { Effect, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import skillText from '../../../skills/pipes/SKILL.md' with { type: 'text' };
import { Agent, decodeConfig } from '@pipes/protocol';
import { PipesError } from '@pipes/protocol';
import { selfCommand } from './self';
import { acpError, codexMcp, codexMcpInstalled, codexSkillPath, probeCodex } from './codex-acp';

export const installCodex = Effect.fn('installCodex')(function* (home = homedir()) {
  const filename = codexSkillPath(home);
  yield* Effect.tryPromise({
    catch: (error) =>
      new PipesError({
        message: `Could not install pipes for Codex: ${String(error)}`,
      }),
    try: async () => {
      await mkdir(join(home, '.codex'), { recursive: true });
      await mkdir(dirname(filename), { recursive: true });
      try {
        await writeFile(filename, skillText, { flag: 'wx' });
      } catch (error) {
        if (!Schema.is(Schema.Struct({ code: Schema.Literal('EEXIST') }))(error)) {
          throw error;
        }
      }
    },
  });
  if (!(yield* codexMcpInstalled(home))) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const self = selfCommand(['mcp']);
    yield* spawner
      .string(codexMcp(home, ['add', 'pipes', '--', self.executable, ...self.args]))
      .pipe(
        Effect.mapError(
          (error) =>
            new PipesError({ message: `Could not install the pipes MCP server: ${String(error)}` }),
        ),
      );
    if (!(yield* codexMcpInstalled(home))) {
      return yield* new PipesError({ message: 'Could not install the pipes MCP server.' });
    }
  }
  return filename;
});

export const setupCodex = Effect.fn('setupCodex')(
  function* (input: { agent: typeof Agent.Type; path: string }) {
    const agent = yield* Schema.decodeEffect(Agent)(input.agent).pipe(Effect.mapError(acpError));
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const root = (yield* spawner.string(
      ChildProcess.make('git', ['-C', input.path, 'rev-parse', '--show-toplevel']),
    )).trim();
    if (!root) {
      return yield* new PipesError({
        message: 'Choose a Git repository before creating the starter workflow.',
      });
    }
    yield* probeCodex({ ...agent, path: root });
    const configuration = yield* decodeConfig({
      workflows: {
        'plan-implement-review': {
          steps: [
            {
              agent,
              name: 'plan',
              prompt:
                'Read the task and repository. Write an actionable implementation plan, including checks and open questions.',
            },
            {
              agent,
              name: 'implement',
              prompt:
                'Implement the plan for the task. Run the relevant checks and summarize changes and any unresolved concerns.',
            },
            {
              agent,
              name: 'review',
              prompt:
                'Review the implementation against the task and plan. Check correctness and test coverage. Report findings with file references and any unresolved concerns.',
            },
          ],
        },
      },
    });
    const filename = join(root, '.pipes/config.ts');
    yield* Effect.tryPromise({
      catch: () =>
        new PipesError({
          message: `Could not create ${filename}. Existing files are never overwritten; copy the selected agent settings into your configuration.`,
        }),
      try: async () => {
        await mkdir(join(root, '.pipes'), { recursive: true });
        await writeFile(filename, `export default ${JSON.stringify(configuration, null, 2)};\n`, {
          flag: 'wx',
        });
      },
    });
    return filename;
  },
  Effect.mapError((error) => (error instanceof PipesError ? error : acpError(error))),
);

export const checkCodexConfig = Effect.fn('checkCodexConfig')(
  function* (path: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    // A fresh process also reloads imported workflow files after the user edits them.
    const { args, executable } = selfCommand(['config', path]);
    const output = yield* spawner.string(ChildProcess.make(executable, args));
    const configuration = yield* decodeConfig(
      yield* Effect.try({
        catch: (error) => new PipesError({ message: output.trim() || String(error) }),
        try: () => JSON.parse(output),
      }),
    );
    const checked = new Set<string>();
    for (const workflow of Object.values(configuration.workflows)) {
      for (const { agent } of workflow.steps) {
        const key = JSON.stringify(agent);
        if (!checked.has(key)) {
          yield* probeCodex({ ...agent, path });
          checked.add(key);
        }
      }
    }
    return `Validated workflows: ${Object.keys(configuration.workflows).join(', ')}`;
  },
  Effect.mapError(
    (error) => new PipesError({ message: `Configuration check failed: ${String(error)}` }),
  ),
);
