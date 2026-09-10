import { useKeyboard } from '@opentui/react';
import { Effect, Schedule } from 'effect';
import { useEffect, useState, type ComponentProps } from 'react';
import { Client } from '@pipes/protocol';
import type { App } from './app';

export function Conversation({
  onClose,
  runtime,
  taskId,
  title,
}: {
  onClose: () => void;
  runtime: ComponentProps<typeof App>['runtime'];
  taskId: string;
  title: string;
}) {
  const [text, setText] = useState('Loading conversation…');
  const [error, setError] = useState('');
  useKeyboard((key) => {
    if (key.name === 'escape') {
      onClose();
    }
  });
  useEffect(() => {
    const controller = new AbortController();
    void runtime
      .runPromise(
        Effect.flatMap(Client, (client) => client.conversation({ taskId })).pipe(
          Effect.tap((value) => Effect.sync(() => setText(value))),
          Effect.repeat(Schedule.spaced('1 second')),
        ),
        { signal: controller.signal },
      )
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setError(String(error));
        }
      });
    return () => controller.abort();
  }, [runtime, taskId]);
  return (
    <box
      backgroundColor="#1e1e2e"
      border
      borderColor="#82aaff"
      bottomTitle="Read-only · [↑↓] scroll · [Esc] back"
      flexDirection="column"
      height="100%"
      left={0}
      padding={1}
      position="absolute"
      title={`Conversation · ${title}`}
      top={0}
      width="100%"
      zIndex={10}
    >
      <scrollbox flexGrow={1} focused>
        <text>{text}</text>
      </scrollbox>
      {error && <text fg="#f38ba8">{error}</text>}
    </box>
  );
}
