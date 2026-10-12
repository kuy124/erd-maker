import { useEffect, useRef, type RefObject } from 'react';
import type { EditorState } from '../state/useEditor';

export function useCanvasZoom(container: RefObject<HTMLDivElement>, state: EditorState, cancelDrag: () => void) {
  const latest = useRef({ state, cancelDrag });
  latest.current = { state, cancelDrag };
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    const touches = new Map<number, { x: number; y: number }>();
    let previous: { x: number; y: number; distance: number } | null = null;
    let pinching = false;
    const zoom = (factor: number, from: { x: number; y: number }, to = from) => {
      latest.current.state.setViewport((v) => {
        const next = Math.max(0.25, Math.min(3, v.zoom * factor));
        const ratio = next / v.zoom;
        return { zoom: next, x: to.x - (from.x - v.x) * ratio, y: to.y - (from.y - v.y) * ratio };
      });
    };
    const wheel = (event: WheelEvent) => {
      if ((event.target as Element).closest('button, input, select, textarea')) return;
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
      zoom(Math.exp(-delta * 0.002), { x: event.clientX - rect.left, y: event.clientY - rect.top });
    };
    const measure = () => {
      const [a, b] = [...touches.values()];
      if (!a || !b) return null;
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.hypot(a.x - b.x, a.y - b.y) };
    };
    const pointer = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return;
      if (event.type === 'pointerdown') {
        if (!node.contains(event.target as Node) || (event.target as Element).closest('button, input, select, textarea')) return;
        const rect = node.getBoundingClientRect();
        touches.set(event.pointerId, { x: event.clientX - rect.left, y: event.clientY - rect.top });
        if (touches.size >= 2) {
          pinching = true;
          latest.current.cancelDrag();
          previous = measure();
        }
      } else if (touches.has(event.pointerId)) {
        if (event.type === 'pointermove') {
          const rect = node.getBoundingClientRect();
          touches.set(event.pointerId, { x: event.clientX - rect.left, y: event.clientY - rect.top });
          const next = measure();
          if (next && previous && previous.distance > 0) zoom(next.distance / previous.distance, previous, next);
          previous = next;
        } else {
          touches.delete(event.pointerId);
          previous = measure();
        }
      } else return;
      if (pinching) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (touches.size === 0) pinching = false;
      }
    };
    const clear = () => { touches.clear(); previous = null; pinching = false; };
    node.addEventListener('wheel', wheel, { passive: false });
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) window.addEventListener(type, pointer as EventListener, { capture: true, passive: false });
    window.addEventListener('blur', clear);
    return () => {
      node.removeEventListener('wheel', wheel);
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) window.removeEventListener(type, pointer as EventListener, true);
      window.removeEventListener('blur', clear);
    };
  }, [container]);
}
