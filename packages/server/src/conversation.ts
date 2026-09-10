import { Effect, Schema } from 'effect';
import { readFile } from 'node:fs/promises';
import { PipesError, type Run } from '@pipes/protocol';

const Entry = Schema.Struct({
  prompt: Schema.optionalKey(Schema.String),
  update: Schema.optionalKey(
    Schema.Struct({
      content: Schema.optionalKey(Schema.Unknown),
      entries: Schema.optionalKey(Schema.Unknown),
      rawInput: Schema.optionalKey(Schema.Unknown),
      rawOutput: Schema.optionalKey(Schema.Unknown),
      sessionUpdate: Schema.String,
      status: Schema.optionalKey(Schema.String),
      title: Schema.optionalKey(Schema.String),
      toolCallId: Schema.optionalKey(Schema.String),
    }),
  ),
});
const Text = Schema.Struct({ text: Schema.String, type: Schema.Literal('text') });
const Content = Schema.Struct({ content: Text, type: Schema.Literal('content') });

function contentText(value: unknown): string {
  if (Schema.is(Text)(value)) {
    return value.text;
  }
  if (Schema.is(Content)(value)) {
    return value.content.text;
  }
  if (Array.isArray(value)) {
    return value.map(contentText).join('\n');
  }
  return value === undefined ? '' : JSON.stringify(value, null, 2);
}

export function conversationText(transcript: string) {
  let text = '';
  let speaker = '';
  // An in-progress append may end partway through a JSON record.
  for (const line of transcript.split('\n').slice(0, -1)) {
    if (!line.trim()) {
      continue;
    }
    const entry = Schema.decodeSync(Schema.fromJsonString(Entry))(line);
    if (entry.prompt !== undefined) {
      text += `\n\nAssignment\n${entry.prompt}`;
      speaker = '';
    }
    const update = entry.update;
    if (!update) {
      continue;
    }
    const kind = update.sessionUpdate;
    if (
      kind === 'agent_message_chunk' ||
      kind === 'user_message_chunk' ||
      kind === 'agent_thought_chunk'
    ) {
      const label =
        kind === 'user_message_chunk'
          ? 'User'
          : kind === 'agent_thought_chunk'
            ? 'Agent reasoning summary'
            : 'Agent';
      if (speaker !== label) {
        text += `\n\n${label}\n`;
      }
      text += contentText(update.content);
      speaker = label;
    } else if (kind === 'tool_call' || kind === 'tool_call_update' || kind === 'plan') {
      text += `\n\n${update.title ?? update.toolCallId ?? 'Plan'}${update.status ? ` · ${update.status}` : ''}\n`;
      text += [update.content, update.rawInput, update.rawOutput, update.entries]
        .map(contentText)
        .filter(Boolean)
        .join('\n');
      speaker = '';
    }
  }
  return text.trim();
}

export const readConversation = Effect.fn('readConversation')(function* (run: Run) {
  const sections: Array<string> = [];
  for (const attempt of run.attempts) {
    const text = yield* Effect.tryPromise({
      catch: (error) => new PipesError({ message: `Cannot read conversation: ${String(error)}` }),
      try: async () => {
        // ponytail: reread while inspecting; use incremental reads if transcripts become large.
        const transcript = await readFile(attempt.transcript, 'utf8').catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT' && attempt.status === 'running') {
              return '';
            }
            throw error;
          },
        );
        return conversationText(transcript);
      },
    });
    sections.push(`${attempt.step} · ${attempt.status}\n${text || 'Waiting for agent messages…'}`);
  }
  return (
    sections.join('\n\n────────────────────────────────\n\n') || 'Preparing the agent session…'
  );
});
