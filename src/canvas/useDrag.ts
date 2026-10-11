/**
 * Pointer interaction.
 *
 * Two jobs: dragging nodes and panning the canvas. Both write high-frequency
 * position updates, and both must NOT write to Yjs on every pointer move —
 * that would flood the peer-to-peer channel with hundreds of updates a second
 * and make remote cursors stutter.
 *
 * So the pattern is: keep the in-flight position in local React state, render
 * from that, and commit to Yjs exactly once on pointer up.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Awareness } from 'y-protocols/awareness';

/**
 * Milliseconds between cursor broadcasts.
 *
 * Awareness re-broadcasts on every field write, and a pointermove fires far
 * faster than any link can usefully carry — the same reason dragging commits
 * to Yjs only on pointer up. Twenty a second is smooth to the eye and a small
 * fraction of the traffic. Raising this is the first thing to try if a room of
 * many peers ever makes presence feel heavy.
 */
const CURSOR_INTERVAL_MS = 50;

/**
 * Publishes the local pointer into awareness so peers watch the cursor move.
 *
 * This used to hang off the drag listeners, which only exist while a shape is
 * being dragged or the canvas panned. That made the cursor appear only once
 * somebody grabbed something — you had to drag to be seen. It is a separate
 * listener now, always on, so moving the mouse is enough.
 *
 * The cursor is cleared when the pointer leaves the window, because otherwise a
 * peer who alt-tabs away leaves a frozen arrow parked on the diagram for the
 * full 30-second awareness timeout, pointing at nothing.
 */
export function usePeerCursor(
  toWorld: (clientX: number, clientY: number) => { x: number; y: number },
  awareness: Awareness,
  /**
   * Optional ref recording the raw client position on every move.
   *
   * Unthrottled on purpose, and deliberately not state: this drives where a new
   * shape appears, so it has to be exact, but it is read only when a key is
   * pressed. Putting it in React state would re-render the whole editor on
   * every pointer move.
   */
  pointer?: React.MutableRefObject<{ x: number; y: number } | null>,
): void {
  const latest = useRef({ toWorld, awareness });
  latest.current = { toWorld, awareness };

  useEffect(() => {
    let lastSent = 0;
    let sent = false;
    let timer: number | null = null;
    let pending: PointerEvent | null = null;

    const publish = (event: PointerEvent) => {
      pending = null;
      sent = true;
      lastSent = performance.now();
      latest.current.awareness.setLocalStateField('cursor', latest.current.toWorld(event.clientX, event.clientY));
    };

    /**
     * Leading edge, plus the position the pointer actually stopped at.
     *
     * A plain "skip anything within 50ms" throttle also throws away the last
     * event of a gesture, so the cursor froze wherever the pointer was when the
     * window closed rather than where it came to rest. Keeping the newest event
     * and sending it on the trailing edge costs one field write and makes the
     * final position correct.
     */
    const move = (event: PointerEvent) => {
      if (pointer) pointer.current = { x: event.clientX, y: event.clientY };
      pending = event;
      if (timer !== null) return; // A send is already queued; it will pick this up.
      timer = window.setTimeout(() => {
        timer = null;
        if (pending) publish(pending);
      }, Math.max(0, CURSOR_INTERVAL_MS - (performance.now() - lastSent)));
    };

    const clear = () => {
      if (timer !== null) { window.clearTimeout(timer); timer = null; }
      pending = null;
      if (pointer) pointer.current = null;
      if (!sent) return;
      sent = false;
      lastSent = 0;
      latest.current.awareness.setLocalStateField('cursor', null);
    };

    window.addEventListener('pointermove', move);
    // `pointerleave` on the document fires when the pointer exits the window;
    // `blur` covers alt-tabbing away, which is how people actually leave.
    document.addEventListener('pointerleave', clear);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('pointermove', move);
      document.removeEventListener('pointerleave', clear);
      window.removeEventListener('blur', clear);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [pointer]);
}

export interface DragState {
  id: string;
  /** Grab offset from the node's top-left, in world units. */
  offsetX: number;
  offsetY: number;
  /** Current local position while the drag is in flight. */
  x: number;
  y: number;
  moved: boolean;
}

export interface PanState {
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

interface Options {
  /** Converts a client point to world coordinates. */
  toWorld: (clientX: number, clientY: number) => { x: number; y: number };
  /** Called once, on drop, with the final position. */
  onCommit: (id: string, x: number, y: number) => void;
  onPan: (x: number, y: number) => void;
  viewport: { x: number; y: number; zoom: number };
  /** True when the current tool pans instead of selecting. */
  panMode: boolean;
}

export interface DragApi {
  drag: DragState | null;
  beginNodeDrag: (id: string, worldX: number, worldY: number, nodeX: number, nodeY: number) => void;
  beginPan: (clientX: number, clientY: number) => void;
}

export function useDrag(options: Options): DragApi {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [pan, setPan] = useState<PanState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const panRef = useRef<PanState | null>(null);

  // Keep the latest callbacks without re-binding listeners on every render.
  const latest = useRef(options);
  latest.current = options;

  const beginNodeDrag = useCallback(
    (id: string, worldX: number, worldY: number, nodeX: number, nodeY: number) => {
      const next: DragState = {
        id,
        offsetX: worldX - nodeX,
        offsetY: worldY - nodeY,
        x: nodeX,
        y: nodeY,
        moved: false,
      };
      dragRef.current = next;
      setDrag(next);
    },
    [],
  );

  const beginPan = useCallback((clientX: number, clientY: number) => {
    const next: PanState = {
      startX: clientX,
      startY: clientY,
      originX: latest.current.viewport.x,
      originY: latest.current.viewport.y,
    };
    panRef.current = next;
    setPan(next);
  }, []);

  useEffect(() => {
    if (!drag && !pan) return undefined;

    const onMove = (event: PointerEvent) => {
      const currentDrag = dragRef.current;
      if (currentDrag) {
        const world = latest.current.toWorld(event.clientX, event.clientY);
        const next: DragState = {
          ...currentDrag,
          x: world.x - currentDrag.offsetX,
          y: world.y - currentDrag.offsetY,
          moved: true,
        };
        dragRef.current = next;
        setDrag(next);
        return;
      }

      const currentPan = panRef.current;
      if (currentPan) {
        latest.current.onPan(
          currentPan.originX + (event.clientX - currentPan.startX),
          currentPan.originY + (event.clientY - currentPan.startY),
        );
      }
    };

    const onUp = () => {
      const finished = dragRef.current;
      if (finished) {
        if (finished.moved) {
          latest.current.onCommit(finished.id, finished.x, finished.y);
        }
        dragRef.current = null;
        setDrag(null);
      }
      if (panRef.current) {
        panRef.current = null;
        setPan(null);
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [drag, pan]);

  return {
    drag,
    beginNodeDrag,
    beginPan,
  };
}
