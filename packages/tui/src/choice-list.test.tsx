import { expect, test } from 'bun:test';
import { ChoiceList } from './choice-list';
import { press, withView } from './test-helpers';

test('choice rows stay single-line and navigate with keyboard', async () => {
  const selected: Array<number> = [];
  const changed: Array<number> = [];
  await withView(
    <ChoiceList
      onChange={(index) => changed.push(index)}
      onSelect={(index) => selected.push(index)}
      options={[
        { detail: '/very/long/path/that/would/wrap/many/times/over/and/over', name: 'First' },
        { name: 'Second' },
        { name: 'Third' },
      ]}
    />,
    { height: 8, width: 30 },
    async (view) => {
      await view.flush();
      const rows = view.captureCharFrame().split('\n');
      expect(rows[0]).toContain('❯ First');
      expect(rows[1]).toContain('Second');
      expect(rows[2]).toContain('Third');
      await press(view, 'ARROW_DOWN');
      expect(view.captureCharFrame().split('\n')[1]).toContain('❯ Second');
      expect(changed).toEqual([1]);
      await press(view, 'ARROW_UP');
      expect(view.captureCharFrame().split('\n')[0]).toContain('❯ First');
      await press(view, 'ARROW_DOWN');
      await press(view, 'RETURN');
      expect(selected).toEqual([1]);
    },
  );
});

test('choice window follows selection with scroll markers', async () => {
  await withView(
    <ChoiceList
      maxVisible={3}
      options={[
        { name: 'one' },
        { name: 'two' },
        { name: 'three' },
        { name: 'four' },
        { name: 'five' },
      ]}
    />,
    { height: 8, width: 30 },
    async (view) => {
      await view.flush();
      let frame = view.captureCharFrame();
      expect(frame).toContain('one');
      expect(frame).toContain('↓ three');
      expect(frame).not.toContain('four');
      await press(view, 'ARROW_DOWN');
      await press(view, 'ARROW_DOWN');
      await press(view, 'ARROW_DOWN');
      frame = view.captureCharFrame();
      expect(frame).toContain('↑ two');
      expect(frame).toContain('❯ four');
      expect(frame).not.toContain('one');
    },
  );
});

test('busy choices ignore keyboard input', async () => {
  const selected: Array<number> = [];
  await withView(
    <ChoiceList busy onSelect={(index) => selected.push(index)} options={[{ name: 'only' }]} />,
    { height: 4, width: 30 },
    async (view) => {
      await view.flush();
      await press(view, 'RETURN');
      expect(selected).toEqual([]);
      expect(view.captureCharFrame()).toContain('only');
    },
  );
});
