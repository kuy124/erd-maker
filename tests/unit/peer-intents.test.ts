import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeAll, afterEach, expect, it } from 'vitest';
import { intentHalo, lassoPolygon } from '../../src/canvas/peerIntents';
import { AttributeShape, EntityShape, PeerCursors } from '../../src/canvas/NodeShapes';
import type { PeerState } from '../../src/collab/provider';
import type { Attribute, Entity } from '../../src/model/types';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // PeerCursors integrates its spring on animation frames; jsdom has no clock
  // for them outside a visual environment, so the same fallback the browser API
  // would provide is installed here. The tests never wait on it.
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 16) as unknown as number);
    globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id));
  }
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(reset);

function render(element: ReactElement): HTMLElement {
  reset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  // Inside an <svg> root, or React creates HTML elements for SVG tags and warns.
  act(() => root!.render(createElement('svg', null, element)));
  return container;
}

function reset(): void {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
}

function peer(over: Partial<PeerState> = {}): PeerState {
  return {
    clientId: 7,
    userId: 'erd-mcp',
    name: 'AI assistant',
    color: '#6B3FA0',
    cursor: { x: 120, y: 80 },
    selectedIds: [],
    view: 'chen',
    following: null,
    pressing: false,
    typing: false,
    intent: null,
    dragging: null,
    ...over,
  };
}

const entity: Entity = { id: 'e1', name: 'Customer', x: 100, y: 50, kind: 'strong' };
const attribute: Attribute = { id: 'a1', name: 'email', x: 300, y: 40, kind: 'simple', ownerId: 'e1' };

it('haloes the shape a hover, press, or carry points at, and nothing else', () => {
  expect(intentHalo(peer({ intent: { kind: 'hover', targetId: 'e1' } }))).toBe('e1');
  expect(intentHalo(peer({ intent: { kind: 'press', targetId: 'e1' } }))).toBe('e1');
  expect(intentHalo(peer({ intent: { kind: 'drag', targetId: 'e1' } }))).toBe('e1');
  // A lasso names its shapes through its loop, and thinking has no target yet.
  expect(intentHalo(peer({ intent: { kind: 'lasso', targetId: 'e1' } }))).toBeNull();
  expect(intentHalo(peer({ intent: { kind: 'think' } }))).toBeNull();
  expect(intentHalo(peer())).toBeNull();
});

it('draws a lasso once it encloses an area, never as one or two points', () => {
  const loop = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 }];
  expect(lassoPolygon(peer({ intent: { kind: 'lasso', lasso: loop } })))
    .toBe('0,0 100,0 100,60 0,60');
  expect(lassoPolygon(peer({ intent: { kind: 'lasso', lasso: loop.slice(0, 2) } }))).toBeNull();
  expect(lassoPolygon(peer({ intent: { kind: 'hover', lasso: loop } }))).toBeNull();
  expect(lassoPolygon(peer())).toBeNull();
});

it('rings the target shape while the AI aims at it, in the peer colour', () => {
  const view = render(createElement(PeerCursors, {
    peers: [peer({ intent: { kind: 'hover', targetId: 'e1' } })],
    view: 'chen',
    boundsOf: (id: string) => (id === 'e1' ? { x: 100, y: 50, w: 150, h: 60 } : null),
  }));
  const halo = view.querySelector('rect.peer-intent--hover');
  expect(halo).not.toBeNull();
  expect(halo!.getAttribute('stroke')).toBe('#6B3FA0');
  // A halo sits outside the shape so it reads as attention, not as its edge.
  expect(Number(halo!.getAttribute('x'))).toBeLessThan(100);
  expect(Number(halo!.getAttribute('width'))).toBeGreaterThan(150);
  expect(view.querySelector('.peer-intent--lasso')).toBeNull();
});

it('draws the lasso loop while a group is being swept', () => {
  const view = render(createElement(PeerCursors, {
    peers: [peer({ intent: { kind: 'lasso', lasso: [{ x: 0, y: 0 }, { x: 90, y: 0 }, { x: 90, y: 40 }] } })],
    view: 'chen',
  }));
  const loop = view.querySelector('polygon.peer-intent--lasso');
  expect(loop).not.toBeNull();
  expect(loop!.getAttribute('points')).toBe('0,0 90,0 90,40');
  expect(loop!.getAttribute('stroke')).toBe('#6B3FA0');
  expect(view.querySelector('.peer-intent--hover')).toBeNull();
});

it('marks a thinking peer around its name and leaves a resting peer still', () => {
  const thinking = render(createElement(PeerCursors, {
    peers: [peer({ intent: { kind: 'think' } })],
    view: 'chen',
  }));
  expect(thinking.querySelector('.peer-cursor')!.getAttribute('class')).toContain('peer-cursor--thinking');
  expect(thinking.querySelector('.peer-cursor__thinking')).not.toBeNull();

  const resting = render(createElement(PeerCursors, { peers: [peer()], view: 'chen' }));
  expect(resting.querySelector('.peer-cursor')!.getAttribute('class')).not.toContain('peer-cursor--thinking');
  expect(resting.querySelector('.peer-cursor__thinking')).toBeNull();
  expect(resting.querySelector('.peer-intent--hover')).toBeNull();
  expect(resting.querySelector('.peer-intent--lasso')).toBeNull();
});

it('keeps intents from the other notation off this paper', () => {
  const view = render(createElement(PeerCursors, {
    peers: [peer({ view: 'crowfoot', intent: { kind: 'hover', targetId: 'e1' } })],
    view: 'chen',
    boundsOf: () => ({ x: 100, y: 50, w: 150, h: 60 }),
  }));
  expect(view.querySelector('.peer-intent--hover')).toBeNull();
  expect(view.querySelector('.peer-cursor')).toBeNull();
});

it('marks an arriving entity for an outline draw and an arriving attribute for a spring', () => {
  const arrived = render(createElement(EntityShape, {
    entity, selected: false, onPointerDown: () => {}, enter: true,
  }));
  const entityGroup = arrived.querySelector('[data-node-id="e1"]')!;
  expect(entityGroup.getAttribute('class')).toContain('node--enter-entity');
  // The outline is drawn by dash offset, which needs a normalised path length.
  expect(arrived.querySelector('.node__body')!.getAttribute('pathLength')).toBe('1');

  const parent = render(createElement(AttributeShape, {
    attribute, selected: false, onPointerDown: () => {}, enter: true,
  }));
  expect(parent.querySelector('[data-node-id="a1"]')!.getAttribute('class')).toContain('node--enter-attribute');

  const settled = render(createElement(EntityShape, {
    entity, selected: false, onPointerDown: () => {}, enter: false,
  }));
  expect(settled.querySelector('[data-node-id="e1"]')!.getAttribute('class')).not.toContain('node--enter');
});
