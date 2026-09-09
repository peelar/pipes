import type { Agent, Config } from 'pipes/config';

// Use the model and reasoning IDs advertised by your provider.
const agent = {
  model: 'YOUR_MODEL_ID',
  provider: 'codex',
  reasoning: 'YOUR_REASONING_ID',
} satisfies typeof Agent.Type;

export default {
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
} satisfies Config;
