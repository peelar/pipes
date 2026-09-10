import { useKeyboard } from '@opentui/react';

export type DestructiveAction = { action: string; message: string; run: () => void };

export function ConfirmationAlert({
  destructiveAction,
  onClose,
}: {
  destructiveAction: DestructiveAction | undefined;
  onClose: () => void;
}) {
  const confirm = () => {
    if (destructiveAction) {
      onClose();
      destructiveAction.run();
    }
  };
  useKeyboard((key) => {
    if (!destructiveAction) {
      return;
    } else if (key.name === 'y') {
      confirm();
    } else if (key.name === 'n' || key.name === 'escape') {
      onClose();
    }
  });

  if (!destructiveAction) {
    return null;
  }

  return (
    <box
      alignItems="center"
      height="100%"
      justifyContent="center"
      left={0}
      position="absolute"
      top={0}
      width="100%"
      zIndex={20}
    >
      <box
        backgroundColor="#1e1e2e"
        border
        borderColor="#f38ba8"
        flexDirection="column"
        gap={1}
        maxWidth={70}
        padding={1}
        title="Confirm destructive action"
        width="90%"
      >
        <text fg="#f38ba8">
          <b>{destructiveAction.action}?</b>
        </text>
        <text>{destructiveAction.message}</text>
        <select
          focused
          height={4}
          onSelect={(index) => (index === 0 ? confirm() : onClose())}
          options={[
            {
              description: 'Proceed with this action',
              name: `Yes, ${destructiveAction.action.toLowerCase()}`,
            },
            { description: 'Leave the task unchanged', name: 'No, keep it' },
          ]}
        />
        <text>[↑↓] choose · [Enter] confirm · [y] yes · [n] / [Esc] no</text>
      </box>
    </box>
  );
}
