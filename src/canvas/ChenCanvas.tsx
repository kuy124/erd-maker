/**
 * The Chen-notation canvas.
 *
 * Renders the document as SVG. The scene is structured so that editing chrome
 * (selection rings, peer cursors) lives in the same coordinate space as the
 * diagram but is removed before export, which is why the export module strips
 * by class rather than by re-rendering.
 *
 * Viewport: a single `<g>` carries pan and zoom, so every child works in world
 * coordinates and hit-testing is one inverse transform.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EditorState } from '../state/useEditor';
import { descendantAttributeIds } from '../model/attributes';
import { documentBounds, dragSet, edgePoint, legLabelPoints, nodesInRect, offsetToward, segmentForLeg, type Point } from './geometry';
import { AttributeShape, CardinalityMarker, EntityShape, GroupFrames, IsaShape, PeerCursors, RelationshipShape } from './NodeShapes';
import { useDrag, usePeerCursor } from './useDrag';
import { useCanvasZoom } from './useCanvasZoom';
import { findNode, type ErdDocument, type Positioned } from '../model/types';
import { canConnect } from '../model/placement';

interface Props {
  state: EditorState;
  /** The live SVG element, handed back so the exporter can serialise it. */
  svgRef: React.MutableRefObject<SVGSVGElement | null>;
  connectFrom: string | null;
  setConnectFrom: (id: string | null) => void;
  emptyActions?: React.ReactNode;
  /** Replaces the empty-canvas card entirely; see `emptyState` in App. */
  emptyState?: React.ReactNode;
}


export function ChenCanvas({ state, svgRef, connectFrom, setConnectFrom, emptyActions, emptyState }: Props) {
  const { doc, viewport, selection, tool, peers } = state;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 1200, height: 800 });

  // While a connection is being drawn, the pointer position drives a preview
  // line and the shape under it is highlighted. Without this, connecting two
  // shapes is a two-click gesture with nothing drawn between the clicks, so
  // there is no way to see what is about to happen or to tell what is a valid
  // target.
  const [connectPointer, setConnectPointer] = useState<{ x: number; y: number } | null>(null);
  const [connectTarget, setConnectTarget] = useState<string | null>(null);

  // Track the container size so the SVG fills it. The setter is guarded so an
  // unchanged measurement does not produce a new object and re-render forever.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const update = () => {
      const next = { width: node.clientWidth, height: node.clientHeight };
      setSize((prev) => (prev.width === next.width && prev.height === next.height ? prev : next));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const toWorld = useCallback(
    (clientX: number, clientY: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return {
        x: (clientX - rect.left - viewport.x) / viewport.zoom,
        y: (clientY - rect.top - viewport.y) / viewport.zoom,
      };
    },
    [viewport],
  );

  const drag = useDrag({
    toWorld,
    onCommit: (positions) => state.applyPositions(positions),
    onPan: (x, y) => state.setViewport((v) => ({ ...v, x, y })),
    onSettled: (moved) => {
      // A press that never moved was a click, not a drag: narrow the selection
      // to that one shape. Leaving it alone would mean clicking a selected shape
      // never does anything, which reads as a broken click.
      const pressed = pressedShape.current;
      pressedShape.current = null;
      if (!moved && pressed && selection.length > 1) state.setSelection([pressed]);
    },
    viewport,
    panMode: tool === 'pan',
  });
  const pressedShape = useRef<string | null>(null);

  // Auto-follow: keep the dragged shape visible by nudging the viewport when
  // the pointer approaches an edge, rather than forcing endless manual panning.
  useEffect(() => {
    if (!drag.drag?.moved) return;
    const tick = (event: PointerEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const threshold = 56;
      let dx = 0, dy = 0;
      if (event.clientX < rect.left + threshold) dx = 9;
      else if (event.clientX > rect.right - threshold) dx = -9;
      if (event.clientY < rect.top + threshold) dy = 9;
      else if (event.clientY > rect.bottom - threshold) dy = -9;
      if (dx || dy) state.setViewport((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
    };
    window.addEventListener('pointermove', tick);
    return () => window.removeEventListener('pointermove', tick);
  }, [drag.drag, state]);

  // Show a grabbing cursor on the canvas while we carry a shape.
  useEffect(() => {
    containerRef.current?.classList.toggle('is-dragging', Boolean(drag.drag?.moved));
  }, [drag.drag]);


  // Tell peers while we carry (drag) a shape, so theirs follows live instead
  // of waiting for the drop. Awareness is the right channel: ephemeral, no
  // history, no merge into the document.
  useEffect(() => {
    const active = drag.drag;
    if (!active?.moved) {
      state.awareness.setLocalStateField('dragging', null);
      return;
    }
    const start: Record<string, { x: number; y: number }> = {};
    for (const [id, pos] of active.start) start[id] = pos;
    state.awareness.setLocalStateField('dragging', {
      ids: [...active.start.keys()],
      start,
      dx: active.dx,
      dy: active.dy,
    });
  }, [drag.drag, state.awareness]);

  // Independent of dragging: moving the mouse is enough to be seen.
usePeerCursor(toWorld, state.awareness, state.pointer);

  // Node under the pointer, topmost first so later-drawn wins.
  const nodeAt = useCallback(
    (worldX: number, worldY: number): { id: string; x: number; y: number } | null => {
      const candidates = [
        ...doc.isas.map((i) => ({ id: i.id, x: i.x, y: i.y, w: 96, h: 56 })),
        ...doc.relationships.map((r) => ({ id: r.id, x: r.x, y: r.y, w: 150, h: 72 })),
        ...doc.attributes.map((a) => ({ id: a.id, x: a.x, y: a.y, w: 130, h: 52 })),
        ...doc.entities.map((e) => ({ id: e.id, x: e.x, y: e.y, w: 150, h: 60 })),
      ].reverse();
      for (const c of candidates) {
        if (worldX >= c.x && worldX <= c.x + c.w && worldY >= c.y && worldY <= c.y + c.h) {
          return { id: c.id, x: c.x, y: c.y };
        }
      }
      return null;
    },
    [doc],
  );

  /**
   * Gives the keyboard back to the canvas when the canvas is clicked.
   *
   * Blurring the panel is not enough on its own: the browser still runs its
   * own focus handling for the click, and ends up restoring focus to the name
   * field afterwards. The visible symptom is that after clicking the diagram,
   * typing goes into the inspector instead of doing the shortcut the user
   * pressed, and `Escape` merely blurs instead of cancelling a connection.
   *
   * Cancelling the default action stops that browser focus work, and focusing
   * the canvas puts the keyboard where the user just clicked. Drags still work
   * because movement is tracked with pointer events, which this does not block.
   */
  const focusCanvas = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !containerRef.current?.contains(active)) {
        svgRef.current?.focus();
      }
    },
    [svgRef],
  );

  /**
   * Joins the pending connection to `id`, and decides what the gesture does next.
   *
   * Shared by the drag gesture and the Shift-click one so both behave the same.
   * A Chen relationship is drawn as a chain — entity, diamond, entity — so the
   * gesture stays on the diamond and the next target finishes the other side,
   * rather than making the user start over. It closes once both sides are
   * joined, because an open gesture on a finished relationship would keep
   * saying "pick another shape". A ternary relationship is still possible:
   * start again from the diamond.
   */
  const connectTo = useCallback(
    (id: string): boolean => {
      if (connectFrom === null || id === connectFrom) return false;
      // `doc`, not `displayDoc`: the two differ only while a node is mid-drag,
      // and a drag and a connection are never in flight at the same time.
      if (!canConnect(doc, connectFrom, id)) return false;
      if (!state.connect(connectFrom, id)) return false;
      const anchorId = doc.relationships.some((r) => r.id === connectFrom)
        ? connectFrom
        : doc.relationships.some((r) => r.id === id)
          ? id
          : null;
      const sides = anchorId
        ? doc.legs.filter((l) => l.fromId === anchorId || l.toId === anchorId).length + 1
        : 0;
      setConnectFrom(sides >= 2 ? null : anchorId);
      return true;
    },
    [connectFrom, doc, state, setConnectFrom],
  );

  /**
   * Starts a drag carrying every selected node, or just `id` when it is not
   * already part of the selection.
   *
   * Positions are captured at the start of the gesture so a collaborator's edit
   * landing mid-drag is not overwritten: the drop applies an offset rather than
   * an absolute position.
   */
  const beginSelectionDrag = useCallback(
    (id: string, event: React.PointerEvent) => {
      const ids = dragSet(doc, id, selection);
      const start = new Map<string, { x: number; y: number }>();
      for (const nodeId of ids) {
        const node = findNode(doc, nodeId);
        if (!node) continue;
        start.set(nodeId, { x: node.x, y: node.y });
        /*
         * An attribute belongs to the shape it hangs off, so dragging that
         * shape has to carry it. Without this the owner slides out from under
         * its own attributes and is left looking abandoned, which is also how a
         * collaborator sees it: the position is in the shared document, so it
         * arrives there stranded too.
         */
        const descendants = descendantAttributeIds(doc, nodeId);
        for (const owned of doc.attributes) {
          if (descendants.has(owned.id) && !start.has(owned.id)) {
            start.set(owned.id, { x: owned.x, y: owned.y });
          }
        }
      }
      if (!start.has(id)) return;
      const world = toWorld(event.clientX, event.clientY);
      drag.beginNodeDrag(start, world.x, world.y);
    },
    [doc, selection, toWorld, drag],
  );

  const handleNodePointerDown = useCallback(
    (id: string) => (event: React.PointerEvent) => {
      // Right and middle buttons belong to the context menu and to panning, not
      // to selection. Letting them through would clear the selection the menu is
      // about to act on.
      if (event.button !== 0) return;
      event.stopPropagation();
      if (tool === 'pan') { drag.beginPan(event.clientX, event.clientY); return; }
      focusCanvas(event);

      // The Connect tool draws a line from this shape to wherever the pointer
      // is released. This is the gesture ERDPlus users reach for first, so it
      // must work without a modifier.
      if (tool === 'connect') {
        // Pressing the anchor again re-arms the gesture rather than refusing:
        // after one leg of a chain the gesture stays on the diamond, and the
        // next drag must start by pressing that same diamond.
        if (connectFrom === null || id === connectFrom) {
          if (!isAttribute(doc, id)) setConnectFrom(id);
        } else {
          connectTo(id);
          setConnectPointer(null);
          setConnectTarget(null);
        }
        return;
      }

      // Shift extends the selection rather than starting a drag. Connecting
      // used to live here; it is on the Connect tool now, where a modifier is
      // not needed and the gesture can be seen before it starts.
      if (event.shiftKey) {
        state.toggleSelection(id);
        return;
      }

      if (!selection.includes(id)) state.setSelection([id]);
      pressedShape.current = id;
      beginSelectionDrag(id, event);
    },
    [
      tool,
      connectFrom,
      doc,
      connectTo,
      selection,
      beginSelectionDrag,
      state,
      drag,
      focusCanvas,
    ],
  );

  /** Tracks the marquee in a ref so the window listener sees the live value. */
  const marquee = useRef<{ from: Point; to: Point } | null>(null);
  const [marqueeBox, setMarqueeBox] = useState<{ from: Point; to: Point } | null>(null);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const box = marquee.current;
      if (!box) return;
      box.to = toWorld(event.clientX, event.clientY);
      setMarqueeBox({ from: box.from, to: box.to });
    };
    const up = () => {
      const box = marquee.current;
      marquee.current = null;
      setMarqueeBox(null);
      if (!box) return;
      state.setSelection(nodesInRect(doc, {
        minX: Math.min(box.from.x, box.to.x), minY: Math.min(box.from.y, box.to.y),
        maxX: Math.max(box.from.x, box.to.x), maxY: Math.max(box.from.y, box.to.y),
      }));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [doc, state, toWorld]);

  const handleBackgroundPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0 && event.button !== 1) return;
      // Middle-click, the pan tool, or space-drag all pan the canvas.
      if (tool === 'pan' || event.button === 1) {
        drag.beginPan(event.clientX, event.clientY);
        return;
      }
      // Shift-drag on empty paper draws a marquee. It needs a modifier because
      // plain drag on empty paper pans, and that is deliberate: a canvas that
      // cannot be panned by dragging feels stuck.
      if (tool === 'select' && event.button === 0 && event.shiftKey) {
        const world = toWorld(event.clientX, event.clientY);
        marquee.current = { from: world, to: world };
        setMarqueeBox({ from: world, to: world });
        return;
      }
      // Empty paper always pans, in every tool, so the canvas can never feel
      // stuck. In the Connect tool it deliberately does not cancel a pending
      // connection: a line drawn from a shape passes over empty paper on its
      // way to the target, and clearing there would cancel the gesture the
      // person is halfway through.
      if (tool === 'select' && event.button === 0) {
        focusCanvas(event);
        setConnectFrom(null);
        setConnectPointer(null);
        setConnectTarget(null);
        state.setSelection([]);
        drag.beginPan(event.clientX, event.clientY);
      } else if (tool === 'connect' && event.button === 0) {
        drag.beginPan(event.clientX, event.clientY);
      }
    },
    [tool, drag, setConnectFrom, state, focusCanvas, toWorld],
  );

  /**
   * Tracks the pointer while a connection is pending, and remembers which shape
   * it is over so that shape can be highlighted as the target.
   */
  const handlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (connectFrom === null || (tool !== 'select' && tool !== 'connect')) return;
      const world = toWorld(event.clientX, event.clientY);
      setConnectPointer(world);
      const hovered = nodeAt(world.x, world.y);
      setConnectTarget(
        hovered && hovered.id !== connectFrom && canConnect(displayDoc, connectFrom, hovered.id)
          ? hovered.id
          : null,
      );
    },
    [connectFrom, tool, toWorld, nodeAt],
  );

  /**
   * Releasing a Connect drag over a shape joins them.
   *
   * The drag is the ERDPlus gesture: press on one shape, release on another. The
   * preview line and the highlighted target already say what will happen, so the
   * release is where the connection is committed.
   */
  useEffect(() => {
    if (tool !== 'connect' || connectFrom === null) return undefined;
    const onUp = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const world = toWorld(event.clientX, event.clientY);
      const target = nodeAt(world.x, world.y);
      // Released on nothing, so the drag is abandoned. Leaving the gesture armed
      // would leave the canvas waiting for a shape the person has stopped
      // looking for.
      if (!target || !connectTo(target.id)) setConnectFrom(null);
      setConnectPointer(null);
      setConnectTarget(null);
    };
    const onCancel = () => {
      setConnectFrom(null);
      setConnectPointer(null);
      setConnectTarget(null);
    };
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [tool, connectFrom, connectTo, setConnectFrom, toWorld, nodeAt]);

  /** Escape cancels a pending connection instead of only closing dialogs. */
  useEffect(() => {
    if (connectFrom === null) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Escape inside a text field belongs to the field: it means "I am done
      // typing", and the app-level handler moves focus back to the canvas.
      // Cancelling here as well would silently discard a connection the user
      // was about to complete — they named the relationship, pressed Escape to
      // get back to the canvas, and found it unconnected.
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;
      if (typing) return;
      setConnectFrom(null);
      setConnectPointer(null);
      setConnectTarget(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [connectFrom, setConnectFrom]);

  useCanvasZoom(containerRef, state, drag.cancel);

  // While a node is being dragged, render it at its in-flight position. Peer
  // drags (carried shapes) are folded in too, so a dragged entity follows the
  // carrying peer's cursor live instead of waiting for the drop.
  const displayDoc = useMemo<ErdDocument>(() => {
    const entries: { start: Map<string, { x: number; y: number }>; dx: number; dy: number }[] = [];
    const active = drag.drag;
    if (active?.moved) {
      entries.push({ start: active.start, dx: active.dx, dy: active.dy });
    }
    for (const peer of peers) {
      if (peer.view !== 'chen') continue;
      const d = peer.dragging;
      if (!d) continue;
      entries.push({
        start: new Map(Object.entries(d.start)),
        dx: d.dx,
        dy: d.dy,
      });
    }
    if (entries.length === 0) return doc;
    const move = <T extends Positioned>(list: T[]): T[] =>
      list.map((node) => {
        let x = node.x; let y = node.y;
        for (const entry of entries) {
          const s = entry.start.get(node.id);
          if (s) { x = s.x + entry.dx; y = s.y + entry.dy; }
        }
        // Only rewrite when something actually moved; keeps reference stable
        // enough for memo consumers.
        if (x === node.x && y === node.y) return node;
        return { ...node, x, y } as T;
      });
    return {
      ...doc,
      entities: move(doc.entities),
      attributes: move(doc.attributes),
      relationships: move(doc.relationships),
      isas: move(doc.isas),
    };
  }, [doc, drag.drag, peers]);

  const peerBySelection = useMemo(() => {
    const map = new Map<string, string>();
    for (const peer of peers) {
      for (const id of peer.selectedIds) map.set(id, peer.color);
    }
    return map;
  }, [peers]);

  const isEmpty =
    displayDoc.entities.length === 0 &&
    displayDoc.attributes.length === 0 &&
    displayDoc.relationships.length === 0 &&
    displayDoc.isas.length === 0;

  return (
    <div
      className="canvas-wrap"
      data-tool={tool}
      ref={containerRef}
      onPointerMove={handlePointerMove}
    >
      <svg
        ref={svgRef}
        className="canvas"
        width={size.width}
        height={size.height}
        role="application"
        aria-label="Entity relationship diagram canvas"
        data-testid="canvas"
        onPointerDown={handleBackgroundPointerDown}
        // Focusable so clicking the diagram can hand the keyboard back to it.
        // See `focusCanvas`.
        tabIndex={-1}
      >
        {/* `data-viewport` marks the pan and zoom group. The exporter resets it,
            because a file that keeps the on-screen transform lands outside its
            own viewBox as soon as the user has panned or zoomed. */}
        <g
          data-viewport="true"
          transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}
        >
          {/* Legs first, so shapes sit on top of their connectors. */}
          <GroupFrames doc={displayDoc} />

          <g className="layer-legs">
            {displayDoc.legs.map((leg) => {
              const seg = segmentForLeg(displayDoc, leg);
              if (!seg) return null;
              const isSelected = selection.includes(leg.id);
              const entity = displayDoc.entities.find((node) => node.id === leg.fromId || node.id === leg.toId);
              const relationship = displayDoc.relationships.find((node) => node.id === leg.fromId || node.id === leg.toId);
              const endpoint = entity?.id === leg.fromId ? seg.from : seg.to;
              const toward = seg.points?.[1] ?? (entity?.id === leg.fromId ? seg.to : seg.from);
              const path = seg.points?.map((point, index) => `${index ? 'L' : 'M'}${point.x} ${point.y}`).join(' ');
              const markerCenter = offsetToward(endpoint, toward, 14);
              const many = leg.cardinality !== '1';
              const required = leg.participation.min > 0;
              const advanced = leg.participation.min > 1 ||
                leg.participation.max !== (many ? 'N' : 1);
              const labels = legLabelPoints(seg.from, seg.to, [0.28, 0.52]);
              const participationLabel = legLabelPoints(seg.from, seg.to, [0.28, 0.52], -14)[1];
              return (
                <g key={leg.id} className="leg-group" data-selection-id={leg.id} tabIndex={-1}>
                  {/* An invisible wider band under the visible line, so the thin
                      stroke is still easy to click. `pointer-events: stroke`
                      makes it hit-testable even though it is not painted. It is
                      drawn first so the labels below stay on top of it. */}
                  {path ? <path className="leg-hit" data-testid="leg-hit" d={path}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      event.stopPropagation(); state.setSelection([leg.id]);
                    }} /> : <line
                    className="leg-hit"
                    data-testid="leg-hit"
                    x1={seg.from.x}
                    y1={seg.from.y}
                    x2={seg.to.x}
                    y2={seg.to.y}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      event.stopPropagation();
                      state.setSelection([leg.id]);
                    }}
                  />}
                  {path ? <path className={`leg${isSelected ? ' leg--selected' : ''}`} d={path} /> : <line
                    className={`leg${isSelected ? ' leg--selected' : ''}`}
                    x1={seg.from.x}
                    y1={seg.from.y}
                    x2={seg.to.x}
                    y2={seg.to.y}
                  />}
                  {entity && relationship ? <>
                    <g className="leg-endpoint" data-testid="leg-cardinality" role="button" tabIndex={-1}
                      aria-label={`${entity.name}: ${required ? 'required' : 'optional'} ${many ? 'many' : 'one'}. Edit relationship line`}
                      data-entity-id={entity.id} data-cardinality={leg.cardinality}
                      data-min={leg.participation.min} data-max={leg.participation.max}
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        event.stopPropagation();
                        if (tool === 'pan') { drag.beginPan(event.clientX, event.clientY); return; }
                        focusCanvas(event);
                        state.setSelection([leg.id]);
                      }}>
                      <title>{`${entity.name}: ${required ? 'required' : 'optional'} ${many ? 'many' : 'one'} ${formatParticipation(leg.participation.min, leg.participation.max)}. Click to edit.`}</title>
                      <rect className="leg-endpoint__hit" x={markerCenter.x - 22 / viewport.zoom}
                        y={markerCenter.y - 22 / viewport.zoom} width={44 / viewport.zoom} height={44 / viewport.zoom} />
                      <CardinalityMarker origin={endpoint} toward={toward} many={many} required={required}
                        className={`leg${isSelected ? ' leg--selected' : ''}`} />
                    </g>
                    {advanced ? <text className="leg__participation" data-testid="leg-participation"
                      x={participationLabel.x} y={participationLabel.y}
                      onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); state.setSelection([leg.id]); }}>
                      {formatParticipation(leg.participation.min, leg.participation.max)}
                    </text> : null}
                  </> : <>
                  {/* Legacy lines between other concepts retain their numeric labels. */}
                  <text
                    className="leg__cardinality"
                    data-testid="leg-cardinality"
                    x={labels[0].x}
                    y={labels[0].y}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      event.stopPropagation();
                      state.setSelection([leg.id]);
                    }}
                  >
                    {leg.cardinality}
                  </text>
                  <text
                    className="leg__participation"
                    data-testid="leg-participation"
                    x={participationLabel.x}
                    y={participationLabel.y}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      event.stopPropagation();
                      state.setSelection([leg.id]);
                    }}
                  >
                    {formatParticipation(leg.participation.min, leg.participation.max)}
                  </text>
                  </>}
                </g>
              );
            })}
            {/* ISA edges: from the triangle up to the parent, down to each child. */}
            {displayDoc.isas.map((isa) => {
              const isaCenter = { x: isa.x + 48, y: isa.y + 28 };
              const parent = isa.parentId
                ? displayDoc.entities.find((e) => e.id === isa.parentId)
                : undefined;
              return (
                <g key={isa.id}>
                  {parent ? (
                    <line
                      className="leg"
                      x1={isaCenter.x}
                      y1={isaCenter.y}
                      x2={edgePoint(displayDoc, parent.id, isaCenter)?.x ?? parent.x}
                      y2={edgePoint(displayDoc, parent.id, isaCenter)?.y ?? parent.y}
                    />
                  ) : null}
                  {isa.childIds.map((childId) => {
                    const child = displayDoc.entities.find((e) => e.id === childId);
                    if (!child) return null;
                    const edge = edgePoint(displayDoc, childId, isaCenter);
                    return (
                      <line
                        key={childId}
                        className="leg"
                        x1={isaCenter.x}
                        y1={isaCenter.y}
                        x2={edge?.x ?? child.x}
                        y2={edge?.y ?? child.y}
                      />
                    );
                  })}
                </g>
              );
            })}
            {/* Attributes with an owner get a connector to it. */}
            {displayDoc.attributes.map((attr) => {
              if (!attr.ownerId) return null;
              const owner = findOwnerCenter(displayDoc, attr.ownerId);
              if (!owner) return null;
              const attrCenter = { x: attr.x + 65, y: attr.y + 26 };
              const from = edgePoint(displayDoc, attr.ownerId, attrCenter);
              const to = edgePoint(displayDoc, attr.id, owner);
              if (!from || !to) return null;
              return (
                <line
                  key={`${attr.id}-link`}
                  // Distinguished from a relationship leg: this one says which
                  // shape an attribute belongs to and carries no cardinality.
                  className="leg leg--attribute"
                  data-attribute-link={attr.id}
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                />
              );
            })}

            {/* The connection being drawn right now. It snaps to the hovered
                shape when one is under the pointer, so it is obvious what will
                be connected before the click lands. */}
            {connectFrom && connectPointer
              ? (() => {
                  const origin = edgePoint(displayDoc, connectFrom, connectPointer);
                  const anchor = { x: origin?.x ?? connectPointer.x, y: origin?.y ?? connectPointer.y };
                  const destination = connectTarget
                    ? edgePoint(displayDoc, connectTarget, anchor)
                    : connectPointer;
                  if (!origin || !destination) return null;
                  return (
                    <line
                      className="connect-preview"
                      data-testid="connect-preview"
                      x1={origin.x}
                      y1={origin.y}
                      x2={destination.x}
                      y2={destination.y}
                    />
                  );
                })()
              : null}
          </g>

          {/* Shapes. `connecting` marks the shape a leg is being drawn from, and
              `connectable` marks a legal target, so the gesture is visible
              rather than something the user has to hold in their head. */}
          <g className="layer-nodes">
            {displayDoc.isas.map((isa) => (
              <IsaShape
                key={isa.id}
                isa={isa}
                selected={selection.includes(isa.id)}
                peerColor={peerBySelection.get(isa.id)}
                connecting={connectFrom === isa.id}
                connectable={connectFrom !== null && connectTarget === isa.id}
                onPointerDown={handleNodePointerDown(isa.id)}
              />
            ))}
            {displayDoc.relationships.map((rel) => (
              <RelationshipShape
                key={rel.id}
                relationship={rel}
                selected={selection.includes(rel.id)}
                peerColor={peerBySelection.get(rel.id)}
                connecting={connectFrom === rel.id}
                connectable={connectFrom !== null && connectTarget === rel.id}
                onPointerDown={handleNodePointerDown(rel.id)}
              />
            ))}
            {displayDoc.attributes.map((attr) => (
              <AttributeShape
                key={attr.id}
                attribute={attr}
                selected={selection.includes(attr.id)}
                peerColor={peerBySelection.get(attr.id)}
                connecting={connectFrom === attr.id}
                connectable={connectFrom !== null && connectTarget === attr.id}
                onPointerDown={handleNodePointerDown(attr.id)}
              />
            ))}
            {displayDoc.entities.map((entity) => (
              <EntityShape
                key={entity.id}
                entity={entity}
                selected={selection.includes(entity.id)}
                peerColor={peerBySelection.get(entity.id)}
                connecting={connectFrom === entity.id}
                connectable={connectFrom !== null && connectTarget === entity.id}
                onPointerDown={handleNodePointerDown(entity.id)}
              />
            ))}
          </g>

          {/* The marquee. Screen-space rectangle inside the world transform. */}
          {marqueeBox ? (
            <path
              className="marquee"
              d={`M${Math.min(marqueeBox.from.x, marqueeBox.to.x)} ${Math.min(marqueeBox.from.y, marqueeBox.to.y)}
                  H${Math.max(marqueeBox.from.x, marqueeBox.to.x)}
                  V${Math.max(marqueeBox.from.y, marqueeBox.to.y)}
                  H${Math.min(marqueeBox.from.x, marqueeBox.to.x)} Z`}
            />
          ) : null}

          {/* Peer cursors. The name always travels with the colour. */}
          <PeerCursors peers={peers} view="chen" />
        </g>
      </svg>

      {emptyState ?? (isEmpty ? (
        <div className="canvas-empty">
          <div className="canvas-empty__card">
            <h2 className="canvas-empty__title">Start with an entity</h2>
            <p className="canvas-empty__body">
              An entity is something you keep records about, such as a customer or an order.
            </p>
            {emptyActions}
            <p className="canvas-empty__hint">E adds an entity · A adds an attribute · R adds a relationship</p>
          </div>
        </div>
      ) : null)}

    </div>
  );
}

function isAttribute(doc: ErdDocument, id: string): boolean {
  return doc.attributes.some((a) => a.id === id);
}

function formatParticipation(min: number, max: number | 'N'): string {
  return `(${min},${max})`;
}

function findOwnerCenter(doc: ErdDocument, ownerId: string): { x: number; y: number } | null {
  const entity = doc.entities.find((e) => e.id === ownerId);
  if (entity) return { x: entity.x + 75, y: entity.y + 30 };
  const rel = doc.relationships.find((r) => r.id === ownerId);
  if (rel) return { x: rel.x + 75, y: rel.y + 36 };
  const isa = doc.isas.find((i) => i.id === ownerId);
  if (isa) return { x: isa.x + 48, y: isa.y + 28 };
  const attr = doc.attributes.find(a => a.id === ownerId && a.kind === 'composite');
  if (attr) return { x: attr.x + 65, y: attr.y + 26 };
  return null;
}

export { documentBounds };
