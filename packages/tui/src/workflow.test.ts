import { expect, test } from 'bun:test';
import { workflowProgress } from './app';

test('workflow progress shows ordered steps and their latest state', () => {
  const agent = { model: 'small', provider: 'codex' as const, reasoning: 'low' };
  expect(
    workflowProgress({
      attempts: [
        { id: 'old', status: 'interrupted', step: 'plan', transcript: '' },
        { id: 'new', status: 'completed', step: 'plan', transcript: '' },
      ],
      configuration: {
        workflows: {
          delivery: {
            steps: [
              { agent, name: 'plan', prompt: 'Plan the work.' },
              { agent, name: 'build', prompt: 'Build it.' },
            ],
          },
        },
      },
      workflow: 'delivery',
    }),
  ).toEqual([
    { name: 'plan', status: 'completed' },
    { name: 'build', status: 'waiting' },
  ]);
});
