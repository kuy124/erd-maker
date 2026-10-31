/**
 * One check on the departure hook: a shape that leaves the paper is held,
 * fades out, and is swept even when the document changes underneath it.
 *
 * The last part is the one that used to break: the sweep ran on the same
 * effect as the document, so an unrelated edit mid-fade cancelled the only
 * timer that would ever take the ghost off the paper.
 */

import { createRoot, type Root } from 'react-dom/client';
import { act, createElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useDepartures } from '../../src/canvas/departures';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

interface Item { id: string }

let container: HTMLElement;
let root: Root;
let departing: Item[] = [];

function Host({ items }: { items: Item[] }) {
  departing = useDepartures(items, (item) => item.id);
  return null;
}

function setItems(items: Item[]): void {
  act(() => root.render(createElement(Host, { items })));
}

it('holds a removed shape, sweeps it, and does not strand it on a later edit', () => {
  vi.useFakeTimers();
  setItems([{ id: 'a' }, { id: 'b' }]);
  // Shapes that were there when the paper opened are the baseline: nothing
  // ever fades them.
  act(() => { vi.advanceTimersByTime(500); });
  expect(departing).toEqual([]);

  // Taking a shape away keeps it on the paper a moment longer.
  setItems([{ id: 'a' }]);
  expect(departing.map((item) => item.id)).toEqual(['b']);

  // An unrelated change while b is still fading must not strand it: the
  // sweep is on its own clock.
  setItems([{ id: 'a' }]);
  act(() => { vi.advanceTimersByTime(500); });
  expect(departing).toEqual([]);

  // And a shape that leaves later still goes, the clock having restarted.
  setItems([{ id: 'a' }, { id: 'c' }]);
  act(() => { vi.advanceTimersByTime(100); });
  setItems([{ id: 'c' }]);
  expect(departing.map((item) => item.id)).toEqual(['a']);
  act(() => { vi.advanceTimersByTime(500); });
  expect(departing).toEqual([]);
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  departing = [];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});
