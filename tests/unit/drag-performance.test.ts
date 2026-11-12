import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { createExample } from '../../src/model/examples';
import { indexGeometrySnapshot, segmentForLeg } from '../../src/canvas/geometry';

test('indexed Chen geometry matches mutable geometry without rescanning node arrays', () => {
  const doc = createExample('orders');
  const expected = doc.legs.map(leg => segmentForLeg(doc, leg));
  indexGeometrySnapshot(doc);
  const entities = vi.spyOn(doc.entities, 'find');
  const relationships = vi.spyOn(doc.relationships, 'find');
  expect(doc.legs.map(leg => segmentForLeg(doc, leg))).toEqual(expected);
  expect(entities).not.toHaveBeenCalled();
  expect(relationships).not.toHaveBeenCalled();
  entities.mockRestore();
  relationships.mockRestore();
});
import { deriveLinks, deriveTables, routeLinks } from '../../src/model/crowfoot';
import { useDrag, useDragPresence, type DragApi, type DragState } from '../../src/canvas/useDrag';

test('fast drag routing keeps every connector attached to its moving table', () => {
  const doc = createExample('orders');
  const tables = deriveTables(doc);
  const links = deriveLinks(doc);
  const moved = tables.map((table, index) => index === 0 ? { ...table, x: table.x + 137, y: table.y + 81 } : table);
  const routes = routeLinks(moved, links, false);
  expect(routes.size).toBe(new Set(links.map(link => link.id)).size);
  for (const link of links) {
    const route = routes.get(link.id)!;
    const from = moved.find(table => table.entityId === link.fromEntityId)!;
    const to = moved.find(table => table.entityId === link.toEntityId)!;
    expect([from.x, from.x + from.width]).toContain(route.a.x);
    expect([to.x, to.x + to.width]).toContain(route.b.x);
    expect(route.points[0]).toEqual(route.a);
    expect(route.points.at(-1)).toEqual(route.b);
  }
});

test('network drag previews coalesce and pending previews cannot outlive a drop', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const publish = vi.spyOn(awareness, 'setLocalStateField');
  const root = createRoot(document.createElement('div'));
  function Harness({ drag }: { drag: DragState | null }) {
    useDragPresence(drag, awareness);
    return null;
  }
  const drag: DragState = { start: new Map([['a', { x: 0, y: 0 }]]), origin: { x: 0, y: 0 }, dx: 1, dy: 0, moved: true };
  try {
    act(() => root.render(createElement(Harness, { drag })));
    act(() => root.render(createElement(Harness, { drag: { ...drag, dx: 2 } })));
    act(() => root.render(createElement(Harness, { drag: { ...drag, dx: 3 } })));
    expect(publish.mock.calls.length).toBeLessThanOrEqual(1);
    act(() => vi.advanceTimersByTime(33));
    expect(awareness.getLocalState()?.dragging.dx).toBe(3);
    act(() => root.render(createElement(Harness, { drag: { ...drag, dx: 4 } })));
    act(() => root.render(createElement(Harness, { drag: null })));
    act(() => vi.advanceTimersByTime(100));
    expect(awareness.getLocalState()?.dragging).toBeNull();
  } finally {
    act(() => root.unmount());
    awareness.destroy();
    doc.destroy();
    vi.useRealTimers();
  }
});

test('pointer bursts render once per frame and drop commits the newest position', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const commit = vi.fn();
  let api: DragApi;
  let renders = 0;
  function Harness() {
    renders++;
    api = useDrag({ toWorld: (x, y) => ({ x, y }), onCommit: commit, onPan: vi.fn(),
      viewport: { x: 0, y: 0, zoom: 1 }, panMode: false });
    return null;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    act(() => root.render(createElement(Harness)));
    act(() => api.beginNodeDrag(new Map([['a', { x: 10, y: 20 }]]), 0, 0));
    const before = renders;
    act(() => {
      for (let x = 1; x <= 100; x++) window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: x }));
    });
    expect(renders).toBe(before);
    expect(frames).toHaveLength(1);
    act(() => frames[0]!(0));
    expect(renders).toBe(before + 1);
    expect(api!.drag?.dx).toBe(100);
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 120, clientY: 120 }));
      window.dispatchEvent(new MouseEvent('pointerup'));
    });
    expect(commit).toHaveBeenCalledWith(new Map([['a', { x: 130, y: 140 }]]));
    expect(api!.drag).toBeNull();
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
