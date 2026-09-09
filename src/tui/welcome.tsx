import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { Schema } from 'effect';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ReactNode, useEffect, useState } from 'react';

export const logo = `╭────┬──╮  ╭───┬───╮  ╭────┬──╮  ╭────┬──╮  ╭──┬────╮
│    │  │  │   │   │  │    │  │  │    │  │  │  │    │
├────┼──╯  ╰───┼───╯  ├────┼──╯  ├────┴──╯  ╰──┴─┬──╯
│    │        │      │    │      ├────┬──╮  ╭────┴──╮
├────┤    ╭───┼───╮  ├────┤      ├────┴──╯  ╰──┬────┤
│    │    │   │   │  │    │      │    │      │  │    │
╰────╯    ╰───┴───╯  ╰────╯      ╰────┴──╯  ╰──┴────╯`;

export function claimWelcome(directory: string) {
  try {
    writeFileSync(join(directory, 'welcome-seen'), '', { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if (Schema.is(Schema.Struct({ code: Schema.Literal('EEXIST') }))(error)) {
      return false;
    }
    throw error;
  }
}

export function Welcome({ children, firstLaunch }: { children: ReactNode; firstLaunch: boolean }) {
  const [show, setShow] = useState(firstLaunch);
  const [columns, setColumns] = useState(0);
  const { height, width } = useTerminalDimensions();
  useKeyboard(() => {
    if (show) {
      setShow(false);
    }
  });
  useEffect(() => {
    if (!show) {
      return;
    }
    const animation = setInterval(() => setColumns((value) => Math.min(value + 2, 53)), 40);
    const finish = setTimeout(() => setShow(false), 1800);
    return () => {
      clearInterval(animation);
      clearTimeout(finish);
    };
  }, [show]);

  if (!show) {
    return children;
  }
  const compact = width < 57 || height < 13;
  return (
    <box alignItems="center" flexDirection="column" gap={1} height="100%" justifyContent="center">
      <text fg="#82aaff">
        {compact
          ? 'pipes'.slice(0, columns)
          : logo
              .split('\n')
              .map((line) => line.slice(0, columns).padEnd(53))
              .join('\n')}
      </text>
      <text fg="#a6adc8">Press [any key] to continue</text>
    </box>
  );
}
