import { expect, test } from 'bun:test';
import { Effect } from 'effect';
import example from '../.pipes/pipes';
import { decodeConfig } from './config';

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
  const child = Bun.spawn([process.execPath, 'src/cli.ts', 'config', '.'], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe('');
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toEqual(example);
});
