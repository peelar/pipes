import type { Run } from '@pipes/protocol';

export function buildStepPrompt(
  run: Run,
  step: { name: string; prompt: string; routes?: Record<string, unknown> },
  attemptId: string,
) {
  const outputs = step.routes ? Object.keys(step.routes) : [];
  return [
    `pipes task ${run.taskId}, run ${run.id}, step ${step.name}, attempt ${attemptId}.`,
    `Task: ${run.title}\n${run.brief}`,
    `Assignment:\n${step.prompt}`,
    outputs.length > 0
      ? `Route decision: when reporting completed, include exactly one output: ${outputs.join(' | ')}. The output selects which branch of the workflow runs next.`
      : undefined,
    `Previous results:\n${run.attempts
      .slice(0, -1)
      .map(
        (previous) =>
          `${previous.step}${previous.result?.output ? ` → ${previous.result.output}` : ''}: ${previous.result?.summary ?? ''}\nTranscript: ${previous.transcript}`,
      )
      .join('\n\n')}`,
    `Work locally. Do not push, publish, merge, or act on other steps. Submit ${outputs.length > 0 ? 'completed with the output, or blocked or failed, ' : 'completed, blocked, or failed, '}with a summary using the pipes report_result MCP tool, then end your turn. Include changes, checks, and unresolved concerns. A plain final message does not complete the step.`,
  ]
    .filter((part) => part !== undefined)
    .join('\n\n');
}
