import type { Run } from '@pipes/protocol';

export function buildStepPrompt(
  run: Run,
  step: { name: string; prompt: string },
  attemptId: string,
) {
  return [
    `pipes task ${run.taskId}, run ${run.id}, step ${step.name}, attempt ${attemptId}.`,
    `Task: ${run.title}\n${run.brief}`,
    `Assignment:\n${step.prompt}`,
    `Previous results:\n${run.attempts
      .slice(0, -1)
      .map(
        (previous) =>
          `${previous.step}: ${previous.result?.summary ?? ''}\nTranscript: ${previous.transcript}`,
      )
      .join('\n\n')}`,
    'Work locally. Do not push, publish, merge, or act on other steps. Submit completed, blocked, or failed with a summary using the pipes report_result MCP tool, then end your turn. Include changes, checks, and unresolved concerns. A plain final message does not complete the step.',
  ].join('\n\n');
}
