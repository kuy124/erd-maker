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
import { documentBounds, edgePoint, offsetToward, segmentBetween } from './geometry';
import { AttributeShape, EntityShape, IsaShape, RelationshipShape } from './NodeShapes';
import { useDrag } from './useDrag';
import type { ErdDocument } from '../model/types';
import { canConnect } from '../model/placement';

interface Props {
  state: EditorState;
  /** The live SVG element, handed back so the exporter can serialise it. */
  svgRef: React.MutableRefObject<SVGSVGElement | null>;
  connectFrom: string | null;
  setConnectFrom: (id: string | null) => void;
}

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 3;

export function ChenCanvas({ state, svgRef, connectFrom, setConnectFrom }: Props) {
  const { doc, viewport, selection, tool, peers, identity } = state;
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
  const measuredRef = useCallback((node: HTMLDivElement | null) => {
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
    onCommit: (id, x, y) => {
      // Commit once, on drop, so the network is not flooded mid-drag.
      if (doc.entities.some((e) => e.id === id)) state.updateEntity(id, { x, y });
      else if (doc.attributes.some((a) => a.id === id)) state.updateAttribute(id, { x, y });
      else if (doc.relationships.some((r) => r.id === id)) state.updateRelationship(id, { x, y });
      else state.applyPositions(new Map([[id, { x, y }]]));
    },
    onPointerWorld: (clientX, clientY) => {
      const world = toWorld(clientX, clientY);
      state.awareness.setLocalStateField('cursor', world);
    },
    onPan: (x, y) => state.setViewport((v) => ({ ...v, x, y })),
    viewport,
    panMode: tool === 'pan',
  });

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

  const handleNodePointerDown = useCallback(
    (id: string) => (event: React.PointerEvent) => {
      event.stopPropagation();
      if (tool === 'pan') return;

      // Shift-click connects two nodes, which is the fast path for drawing a leg.
      if (event.shiftKey) {
        if (connectFrom === null) {
          // An attribute cannot be an endpoint: its link to its owner is stored
          // as `ownerId`, so a leg from an attribute is a line that the SQL
          // generator and the crow's-foot view both ignore. Refusing here means
          // the user is never shown a connection that quietly does nothing.
          if (!isAttribute(displayDoc, id)) setConnectFrom(id);
        } else if (connectFrom !== id && canConnect(displayDoc, connectFrom, id)) {
          state.connect(connectFrom, id);
          setConnectFrom(null);
        }
        // Clear the preview: the gesture is either started, finished, or was
        // refused, and either way it is not in flight.
        setConnectPointer(null);
        setConnectTarget(null);
        return;
      }

      state.setSelection(id);
      const world = toWorld(event.clientX, event.clientY);
      const node = nodeAt(world.x, world.y);
      if (node) drag.beginNodeDrag(node.id, world.x, world.y, node.x, node.y);
    },
    [tool, connectFrom, setConnectFrom, state, toWorld, nodeAt, drag],
  );

  const handleBackgroundPointerDown = useCallback(
    (event: React.PointerEvent) => {
      // Middle-click, the pan tool, or space-drag all pan the canvas.
      if (tool === 'pan' || event.button === 1) {
        drag.beginPan(event.clientX, event.clientY);
        return;
      }
      // Clicking empty paper clears the selection and any pending connection.
      if (tool === 'select' && event.button === 0) {
        setConnectFrom(null);
        setConnectPointer(null);
        setConnectTarget(null);
        state.setSelection(null);
        drag.beginPan(event.clientX, event.clientY);
      }
    },
    [tool, drag, setConnectFrom, state],
  );

  /**
   * Tracks the pointer while a connection is pending, and remembers which shape
   * it is over so that shape can be highlighted as the target.
   */
  const handlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (connectFrom === null || tool !== 'select') return;
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

  /** Escape cancels a pending connection instead of only closing dialogs. */
  useEffect(() => {
    if (connectFrom === null) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setConnectFrom(null);
      setConnectPointer(null);
      setConnectTarget(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [connectFrom, setConnectFrom]);

  const handleWheel = useCallback(
    (event: React.WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      state.setViewport((v) => {
        const nextZoom = clamp(v.zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12), ZOOM_MIN, ZOOM_MAX);
        // Zoom about the pointer, so the point under the cursor stays put.
        const ratio = nextZoom / v.zoom;
        return {
          zoom: nextZoom,
          x: pointerX - (pointerX - v.x) * ratio,
          y: pointerY - (pointerY - v.y) * ratio,
        };
      });
    },
    [state],
  );

  // While a node is being dragged, render it at its in-flight position.
  const displayDoc = useMemo<ErdDocument>(() => {
    const active = drag.drag;
    if (!active || !active.moved) return doc;
    return {
      ...doc,
      entities: doc.entities.map((e) => (e.id === active.id ? { ...e, x: active.x, y: active.y } : e)),
      attributes: doc.attributes.map((a) => (a.id === active.id ? { ...a, x: active.x, y: active.y } : a)),
      relationships: doc.relationships.map((r) => (r.id === active.id ? { ...r, x: active.x, y: active.y } : r)),
      isas: doc.isas.map((i) => (i.id === active.id ? { ...i, x: active.x, y: active.y } : i)),
    };
  }, [doc, drag.drag]);

  const peerBySelection = useMemo(() => {
    const map = new Map<string, string>();
    for (const peer of peers) {
      if (peer.selectedId) map.set(peer.selectedId, peer.color);
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
      ref={(node) => {
        containerRef.current = node;
        measuredRef(node);
      }}
      onPointerDown={handleBackgroundPointerDown}
      onPointerMove={handlePointerMove}
      onWheel={handleWheel}
    >
      <svg
        ref={svgRef}
        className="canvas"
        width={size.width}
        height={size.height}
        role="application"
        aria-label="Entity relationship diagram canvas"
        data-testid="canvas"
      >
        {/* `data-viewport` marks the pan and zoom group. The exporter resets it,
            because a file that keeps the on-screen transform lands outside its
            own viewBox as soon as the user has panned or zoomed. */}
        <g
          data-viewport="true"
          transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}
        >
          {/* Legs first, so shapes sit on top of their connectors. */}
          <g className="layer-legs">
            {displayDoc.legs.map((leg) => {
              const seg = segmentBetween(displayDoc, leg.fromId, leg.toId);
              if (!seg) return null;
              const isSelected = selection === leg.id;
              return (
                <g key={leg.id} className="leg-group">
                  {/* An invisible wider band under the visible line, so the thin
                      stroke is still easy to click. `pointer-events: stroke`
                      makes it hit-testable even though it is not painted. It is
                      drawn first so the labels below stay on top of it. */}
                  <line
                    className="leg-hit"
                    data-testid="leg-hit"
                    x1={seg.from.x}
                    y1={seg.from.y}
                    x2={seg.to.x}
                    y2={seg.to.y}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      state.setSelection(leg.id);
                    }}
                  />
                  <line
                    className={`leg${isSelected ? ' leg--selected' : ''}`}
                    x1={seg.from.x}
                    y1={seg.from.y}
                    x2={seg.to.x}
                    y2={seg.to.y}
                  />
                  {/* Cardinality sits near the source end, participation just inside it.
                      Both labels select the leg when clicked, which is the
                      natural way to change a cardinality: click the number. */}
                  <text
                    className="leg__cardinality"
                    data-testid="leg-cardinality"
                    x={offsetToward(seg.from, seg.to, 22).x}
                    y={offsetToward(seg.from, seg.to, 22).y}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      state.setSelection(leg.id);
                    }}
                  >
                    {leg.cardinality}
                  </text>
                  <text
                    className="leg__participation"
                    data-testid="leg-participation"
                    x={offsetToward(seg.from, seg.to, 46).x}
                    y={offsetToward(seg.from, seg.to, 46).y}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      state.setSelection(leg.id);
                    }}
                  >
                    {formatParticipation(leg.participation.min, leg.participation.max)}
                  </text>
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
                selected={selection === isa.id}
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
                selected={selection === rel.id}
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
                selected={selection === attr.id}
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
                selected={selection === entity.id}
                peerColor={peerBySelection.get(entity.id)}
                connecting={connectFrom === entity.id}
                connectable={connectFrom !== null && connectTarget === entity.id}
                onPointerDown={handleNodePointerDown(entity.id)}
              />
            ))}
          </g>

          {/* Peer cursors. The name always travels with the colour. */}
          <g className="layer-peers">
            {peers.map((peer) =>
              peer.cursor ? (
                <g key={peer.clientId} className="peer-cursor" transform={`translate(${peer.cursor.x} ${peer.cursor.y})`}>
                  <path d="M0 0 L0 15 L4 11 L7 17 L10 15.5 L7 10 L12 10 Z" fill={peer.color} stroke="var(--paper)" strokeWidth="1" />
                  <rect className="peer-cursor__chip" x="14" y="12" width={peer.name.length * 6.4 + 10} height="17" fill={peer.color} />
                  <text className="peer-cursor__name" x="19" y="24">
                    {peer.name}
                  </text>
                </g>
              ) : null,
            )}
          </g>
        </g>
      </svg>

      {isEmpty ? (
        <div className="canvas-empty">
          <div className="canvas-empty__card">
            <h2 className="canvas-empty__title">Start with an entity</h2>
            <p className="canvas-empty__body">
              An entity is a thing you keep records about, like a customer or an order. Add one from
              the shape rail, then hang attributes off it and connect it to another entity with a
              relationship.
            </p>
            <p className="canvas-empty__hint">Press E to add an entity, or A for an attribute</p>
          </div>
        </div>
      ) : null}

      <div className="canvas-status" role="status">
        <span
          className={`canvas-status__dot${state.connected ? ' canvas-status__dot--live' : ''}`}
          aria-hidden="true"
        />
        {state.connected
          ? `Live with ${state.peers.length} ${state.peers.length === 1 ? 'peer' : 'peers'}${
              state.directPeers > 0 ? '' : ' in this browser'
            }`
          : 'Editing alone'}
        <span aria-hidden="true">·</span>
        <span>You are {identity.name}</span>
      </div>
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
  return null;
}

export { documentBounds };
