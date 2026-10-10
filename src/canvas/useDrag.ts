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
  /** Called continuously while the pointer moves, for awareness updates. */
  onPointerWorld?: (x: number, y: number) => void;
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
      latest.current.onPointerWorld?.(event.clientX, event.clientY);

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
