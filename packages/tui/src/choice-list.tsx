import { useKeyboard } from '@opentui/react';
import { useState } from 'react';

export type ChoiceOption = { detail?: string; id?: string; name: string };

function clampIndex(index: number, count: number) {
  return Math.min(Math.max(index, 0), Math.max(count - 1, 0));
}

export function ChoiceList({
  busy = false,
  fastStep = 5,
  focused = true,
  maxVisible,
  onChange,
  onSelect,
  options,
  selectedIndex,
}: {
  busy?: boolean;
  fastStep?: number;
  focused?: boolean;
  maxVisible?: number;
  onChange?: (index: number) => void;
  onSelect?: (index: number) => void;
  options: ReadonlyArray<ChoiceOption>;
  selectedIndex?: number;
}) {
  const [internal, setInternal] = useState(0);
  const [offset, setOffset] = useState(0);
  const count = options.length;
  const limit = Math.max(Math.min(maxVisible ?? count, count), 0);
  const current = clampIndex(selectedIndex ?? internal, count);
  const start = Math.min(offset, Math.max(count - limit, 0));
  const visible = options.slice(start, start + limit);

  function move(next: number) {
    const target = clampIndex(next, count);
    if (selectedIndex === undefined) {
      setInternal(target);
    }
    if (target !== current) {
      onChange?.(target);
    }
    setOffset((previous) => {
      const max = Math.max(count - limit, 0);
      if (target < previous) {
        return target;
      }
      if (target >= previous + limit) {
        return Math.min(target - limit + 1, max);
      }
      return Math.min(previous, max);
    });
  }

  useKeyboard((key) => {
    if (busy || !focused || count === 0) {
      return;
    }
    const step = key.shift ? fastStep : 1;
    if (key.name === 'up' || key.name === 'k') {
      key.preventDefault();
      move(current - step);
    } else if (key.name === 'down' || key.name === 'j') {
      key.preventDefault();
      move(current + step);
    } else if (key.name === 'return' || key.name === 'linefeed') {
      key.preventDefault();
      onSelect?.(current);
    }
  });

  return (
    <box flexDirection="column">
      {visible.map((option, position) => {
        const absolute = start + position;
        const selected = absolute === current;
        const marker = selected
          ? '❯ '
          : position === 0 && start > 0
            ? '↑ '
            : position === visible.length - 1 && start + limit < count
              ? '↓ '
              : '  ';
        return (
          <text
            bg={selected ? '#313244' : undefined}
            key={option.id ?? option.name}
            wrapMode="none"
          >
            <span fg={selected ? '#89b4fa' : '#585b70'}>{marker}</span>
            {option.name}
            {option.detail && <span fg="#a6adc8">{`  ${option.detail}`}</span>}
          </text>
        );
      })}
    </box>
  );
}
