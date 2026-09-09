export default {
  workflows: {
    'plan-implement-review': {
      steps: [
        {
          agent: {
            model: 'gpt-5.6-sol',
            provider: 'codex',
            reasoning: 'low',
          },
          name: 'plan',
          prompt:
            'Read the task and repository. Write an actionable implementation plan, including checks and open questions.',
        },
        {
          agent: {
            model: 'gpt-5.6-sol',
            provider: 'codex',
            reasoning: 'low',
          },
          name: 'implement',
          prompt:
            'Implement the plan for the task. Run the relevant checks and summarize changes and any unresolved concerns.',
        },
        {
          agent: {
            model: 'gpt-5.6-sol',
            provider: 'codex',
            reasoning: 'low',
          },
          name: 'review',
          prompt:
            'Review the implementation against the task and plan. Check correctness and test coverage. Report findings with file references and any unresolved concerns.',
        },
      ],
    },
  },
};
