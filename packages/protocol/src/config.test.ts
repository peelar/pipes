import { expect, test } from 'bun:test';
import { Effect } from 'effect';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import example from '../../../.pipes/config';
import { Agent as AgentSchema, decodeConfig, workflowPath, type Step } from './config';
import { validateStepResult } from './pipes';

test('routing steps validate their shape, decisions resolve the active path, and reports are checked', async () => {
  const step = example.workflows['plan-implement-review'].steps[0]!;
  const agent = step.agent as typeof AgentSchema.Type;
  const routed: Step = {
    agent,
    name: 'classify',
    prompt: 'Is this a UI change or a deeper change?',
    routes: {
      deep_change: [],
      ui_change: [{ agent, name: 'implement', prompt: 'Implement the surface change.' }],
    },
  };
  const { github: _github, ...rest } = example;
  expect(
    (await Effect.runPromise(decodeConfig({ ...rest, workflows: { routed: { steps: [routed] } } })))
      .workflows.routed!.steps[0]!.routes,
  ).toEqual(routed.routes);
  for (const invalid of [
    { ...example, workflows: { empty: { steps: [{ ...routed, routes: {} }] } } },
    {
      ...rest,
      workflows: {
        trailing: {
          steps: [routed, { agent, name: 'review', prompt: 'Review it.' }],
        },
      },
    },
    {
      ...rest,
      workflows: {
        duplicate: {
          steps: [
            {
              ...routed,
              routes: {
                deep_change: [],
                ui_change: [{ agent, name: 'classify', prompt: 'Recursive name clash.' }],
              },
            },
          ],
        },
      },
    },
  ]) {
    expect(Effect.runSync(Effect.result(decodeConfig(invalid)))._tag).toBe('Failure');
  }

  const paths = (attempts: Parameters<typeof workflowPath>[1]) =>
    workflowPath([routed], attempts).map(({ decision, step }) => [decision, step.name]);
  expect(paths([])).toEqual([[undefined, 'classify']]);
  expect(
    paths([
      {
        result: { output: 'deep_change', status: 'completed', summary: '' },
        status: 'completed',
        step: 'classify',
      },
    ]),
  ).toEqual([['deep_change', 'classify']]);
  expect(
    paths([
      {
        result: { output: 'ui_change', status: 'completed', summary: '' },
        status: 'completed',
        step: 'classify',
      },
    ]),
  ).toEqual([
    ['ui_change', 'classify'],
    [undefined, 'implement'],
  ]);
  expect(paths([{ result: undefined, status: 'blocked', step: 'classify' }])).toEqual([
    [undefined, 'classify'],
  ]);

  const result = { status: 'completed', summary: 'Looks shallow.' } as const;
  expect(validateStepResult(undefined, { ...result, output: 'ui_change' })).toContain(
    'does not accept an output',
  );
  expect(validateStepResult(routed, result)).toContain('must report exactly one output');
  expect(validateStepResult(routed, { ...result, output: 'middle' })).toContain(
    'output must be one of',
  );
  expect(
    validateStepResult(routed, {
      ...result,
      output: 'ui_change',
      status: 'blocked',
      summary: 'Need more detail.',
    }),
  ).toContain('cannot report an output with blocked');
  expect(validateStepResult(routed, { ...result, output: 'ui_change' })).toBeUndefined();
});

test('configuration validates the example and rejects malformed workflow settings', async () => {
  const decoded = await Effect.runPromise(decodeConfig(example));
  expect(decoded.base).toBeUndefined();
  expect(Effect.runSync(decodeConfig({ ...example, base: 'main' })).base).toBe('main');
  expect(JSON.stringify(decoded)).toBe(JSON.stringify(example));
  const step = example.workflows['plan-implement-review'].steps[0]!;
  for (const invalid of [
    { ...example, base: ' ' },
    { ...example, setup: [] },
    { ...example, setup: [' ', 'install'] },
    { ...example, workflows: {} },
    { ...example, workflows: { empty: { steps: [] } } },
    { ...example, workflows: { duplicate: { steps: [step, step] } } },
    { ...example, workflows: { invalid: { steps: [{ ...step, prompt: () => 'dynamic' }] } } },
    {
      ...example,
      workflows: { invalid: { steps: [{ ...step, agent: { ...step.agent, model: '' } }] } },
    },
    {
      ...example,
      workflows: { invalid: { steps: [{ ...step, agent: { ...step.agent, provider: 'other' } }] } },
    },
    {
      ...example,
      workflows: {
        invalid: { steps: [{ ...step, agent: { ...step.agent, provider: undefined } }] },
      },
    },
    {
      ...example,
      workflows: { invalid: { steps: [{ ...step, agent: { ...step.agent, command: [] } }] } },
    },
    {
      ...example,
      workflows: {
        invalid: { steps: [{ ...step, agent: { ...step.agent, reasoning: undefined } }] },
      },
    },
    {
      ...example,
      workflows: { invalid: { steps: [{ ...step, agent: { ...step.agent, typo: true } }] } },
    },
  ]) {
    expect(Effect.runSync(Effect.result(decodeConfig(invalid)))._tag).toBe('Failure');
  }
  const directory = await mkdtemp(join(tmpdir(), 'pipes-config-'));
  try {
    await mkdir(join(directory, '.pipes'));
    await writeFile(
      join(directory, '.pipes/config.ts'),
      `export default ${JSON.stringify(example)};`,
    );
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dirname, '../../../src/cli.ts'), 'config', directory],
      {
        stderr: 'pipe',
        stdout: 'pipe',
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual(example);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
