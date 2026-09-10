import { expect, test } from 'bun:test';
import { conversationText } from './conversation';

test('conversation joins streamed messages and preserves tool evidence, ignoring a partial final record', () => {
  const transcript =
    [
      { prompt: 'Implement the task.' },
      {
        update: {
          content: { text: 'Checking ', type: 'text' },
          sessionUpdate: 'agent_message_chunk',
        },
      },
      {
        update: { content: { text: 'tests.', type: 'text' }, sessionUpdate: 'agent_message_chunk' },
      },
      {
        update: {
          sessionUpdate: 'tool_call',
          status: 'in_progress',
          title: 'bun test',
          toolCallId: 'test',
        },
      },
      {
        update: {
          content: [{ content: { text: 'All tests passed.', type: 'text' }, type: 'content' }],
          sessionUpdate: 'tool_call_update',
          status: 'completed',
          toolCallId: 'test',
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n{"update":';
  const text = conversationText(transcript);
  expect(text).toContain('Assignment\nImplement the task.');
  expect(text).toContain('Agent\nChecking tests.');
  expect(text).toContain('bun test · in_progress');
  expect(text).toContain('All tests passed.');
});
