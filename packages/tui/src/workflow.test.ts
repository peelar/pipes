import { expect, test } from 'bun:test';
import { workflowProgress } from './app';

const agent = { model: 'small', provider: 'codex' as const, reasoning: 'low' };

test('workflow progress shows ordered steps and their latest state', () => {
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
    { decision: undefined, name: 'plan', status: 'completed' },
    { decision: undefined, name: 'build', status: 'waiting' },
  ]);
});

test('workflow progress follows recorded route decisions and hides other branches', () => {
  const configuration = {
    workflows: {
      delivery: {
        steps: [
          {
            agent,
            name: 'classify',
            prompt: 'Classify the change.',
            routes: {
              deep_change: [{ agent, name: 'architect', prompt: 'Rearchitect it.' }],
              ui_change: [
                { agent, name: 'implement', prompt: 'Implement it.' },
                { agent, name: 'visual_check', prompt: 'Check it visually.' },
              ],
            },
          },
        ],
      },
    },
  };
  expect(
    workflowProgress({
      attempts: [],
      configuration,
      workflow: 'delivery',
    }),
  ).toEqual([
    { decision: undefined, name: 'classify (deep_change | ui_change)', status: 'waiting' },
  ]);
  expect(
    workflowProgress({
      attempts: [
        {
          id: 'classify',
          result: { output: 'ui_change', status: 'completed', summary: 'Surface change.' },
          status: 'completed',
          step: 'classify',
          transcript: '',
        },
      ],
      configuration,
      workflow: 'delivery',
    }),
  ).toEqual([
    { decision: 'ui_change', name: 'classify → ui_change', status: 'completed' },
    { decision: undefined, name: 'implement', status: 'waiting' },
    { decision: undefined, name: 'visual_check', status: 'waiting' },
  ]);
});
