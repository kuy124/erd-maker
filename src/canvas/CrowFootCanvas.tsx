/**
 * The crow's-foot canvas.
 *
 * A second renderer over the same document, not a second model. Entities become
 * tables with PK/FK rows; relationships use crow's-foot symbols and explicit
 * ratios such as 1:N, 1:1, and N:M. Endpoint stubs stay protected during dragging.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ENDPOINT_STUB, isRouteSafe, moveRouteSegment, placeRouteCaption, type RoutePoint } from '../model/connectorRouting';
import { useCanvasZoom } from './useCanvasZoom';
import {
  CROW_HEADER_HEIGHT,
  CROW_ROW_HEIGHT,
  CROW_NAME_X,
  deriveLinks,
  deriveTables,
  routeColumns,
  rowCenter,
  tableHeight,
  tableObstacle,
  type Obstacle,
  type ColumnEndpoint,
  type CrowLink,
  type CrowTable,
} from '../model/crowfoot';
import type { EditorState } from '../state/useEditor';
import { dragSet, nodesInRect, type Point } from './geometry';
import { useDrag, usePeerCursor } from './useDrag';
import { CardinalityMarker, GroupFrames, PeerCursors } from './NodeShapes';

interface Props {
  state: EditorState;
  svgRef: React.MutableRefObject<SVGSVGElement | null>;
  emptyActions?: React.ReactNode;
  /** Replaces the empty-canvas card entirely; see `emptyState` in App. */
  emptyState?: React.ReactNode;
  /** Commits shared table positions separately from the Chen arrangement. */
  onTablePositions?: (positions: Map<string, { x: number; y: number }>) => void;
}

export function CrowFootCanvas({ state, svgRef, emptyActions, emptyState, onTablePositions }: Props) {
  const { doc, viewport, selection, tool, peers } = state;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 1200, height: 800 });
  const [connectFrom, setConnectFrom] = useState<ColumnEndpoint | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const connectionPress = useRef<{ x: number; y: number; end: ColumnEndpoint } | null>(null);
  const [handleLayer, setHandleLayer] = useState<SVGGElement | null>(null);

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

  const tables = useMemo(() => deriveTables(doc), [doc]);
  const links = useMemo(() => deriveLinks(doc).filter((link, index, all) =>
    all.findIndex((other) => other.relId === link.relId) === index), [doc]);

  useEffect(() => {
    if (tool !== 'connect' || (connectFrom && !tables.find((t) => t.entityId === connectFrom.entityId)?.rows.some((r) => r.id === connectFrom.columnId))) {
      setConnectFrom(null); setPointer(null); connectionPress.current = null;
    }
  }, [tool, tables, connectFrom]);

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
    onCommit: (positions) => {
      if (onTablePositions) onTablePositions(positions);
      else state.applyTablePositions(positions);
    },
    onPan: (x, y) => state.setViewport((v) => ({ ...v, x, y })),
    onSettled: (moved) => {
      // A press that never moved was a click: narrow to that one table.
      const pressed = pressedTable.current;
      pressedTable.current = null;
      if (!moved && pressed && selection.length > 1) state.setSelection([pressed]);
    },
    viewport,
    panMode: tool === 'pan',
  });
  const pressedTable = useRef<string | null>(null);

  // The table view had no presence at all; moving the mouse is now enough to be seen.
  usePeerCursor(toWorld, state.awareness, state.pointer);

  const chooseColumn = (end: ColumnEndpoint) => {
    if (connectFrom) {
      if (connectFrom.entityId === end.entityId && connectFrom.columnId === end.columnId) return;
      state.connectColumns(connectFrom, end);
      setConnectFrom(null); setPointer(null); connectionPress.current = null;
    } else setConnectFrom(end);
  };

  useEffect(() => {
    if (!connectFrom || tool !== 'connect') return;
    const move = (event: PointerEvent) => setPointer(toWorld(event.clientX, event.clientY));
    const up = (event: PointerEvent) => {
      const press = connectionPress.current;
      connectionPress.current = null;
      if (!press) return;
      const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y) >= 6;
      if (!moved && press.end.entityId === connectFrom.entityId && press.end.columnId === connectFrom.columnId) return;
      const row = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-column-id]');
      const entityId = row?.closest('[data-node-id]')?.getAttribute('data-node-id');
      const columnId = row?.getAttribute('data-column-id');
      event.preventDefault();
      if (entityId && columnId && (entityId !== connectFrom.entityId || columnId !== connectFrom.columnId)) {
        state.connectColumns(connectFrom, { entityId, columnId });
      }
      setConnectFrom(null); setPointer(null);
    };
    const cancel = () => { setConnectFrom(null); setPointer(null); connectionPress.current = null; };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel); window.removeEventListener('keydown', key);
    };
  }, [connectFrom, tool, state.connectColumns, toWorld]);

  const handleTablePointerDown = useCallback(
    (id: string) => (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      if (tool === 'pan') { drag.beginPan(event.clientX, event.clientY); return; }
      if (tool === 'connect') return;
      // Shift extends the selection; a plain click on an already-selected table
      // carries the whole selection, matching the Chen view.
      if (event.shiftKey) { state.toggleSelection(id); return; }
      const ids = dragSet(doc, id, selection);
      if (!selection.includes(id)) state.setSelection([id]);
      const start = new Map<string, { x: number; y: number }>();
      for (const nodeId of ids) {
        const table = tables.find((item) => item.entityId === nodeId);
        if (table) start.set(nodeId, { x: table.x, y: table.y });
      }
      if (!start.has(id)) return;
      pressedTable.current = id;
      const world = toWorld(event.clientX, event.clientY);
      drag.beginNodeDrag(start, world.x, world.y);
    },
    [tool, state, toWorld, doc, tables, drag, selection],
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
      if (tool === 'connect') { setConnectFrom(null); setPointer(null); }
      // Shift-drag on empty paper draws a marquee; a plain drag still pans.
      if (tool !== 'pan' && !event.shiftKey && event.button === 0) state.setSelection([]);
      if (tool !== 'pan' && event.shiftKey && event.button === 0) {
        const world = toWorld(event.clientX, event.clientY);
        marquee.current = { from: world, to: world };
        setMarqueeBox({ from: world, to: world });
        return;
      }
      drag.beginPan(event.clientX, event.clientY);
    },
    [tool, state, drag, toWorld],
  );

  useCanvasZoom(containerRef, state, drag.cancel);

  // Render every dragged table at its in-flight position.
  const positioned = useMemo(() => {
    const active = drag.drag;
    return tables.map((table) => {
      if (!active?.moved) return table;
      const start = active.start.get(table.entityId);
      return start ? { ...table, x: start.x + active.dx, y: start.y + active.dy } : table;
    });
  }, [tables, drag.drag]);

  const byId = useMemo(() => new Map(positioned.map((t) => [t.entityId, t])), [positioned]);
  // Where every table is drawn, so a connector can be kept off them.
  const obstacles = useMemo(() => positioned.map(tableObstacle), [positioned]);

  const isEmpty = positioned.length === 0;

  return (
    <div
      className="canvas-wrap"
      data-tool={tool}
      ref={containerRef}
    >
      <svg
        ref={svgRef}
        className="canvas"
        width={size.width}
        height={size.height}
        role="application"
        aria-label="Crow's-foot table diagram canvas"
        data-testid="canvas"
        onPointerDown={handleBackgroundPointerDown}
        tabIndex={-1}
      >
        {/* `data-viewport` marks the pan and zoom group; the exporter resets it. */}
        <g
          data-viewport="true"
          transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}
        >
          <GroupFrames doc={doc} />

          <g className="layer-links">
            {links.map((link) => {
              const from = byId.get(link.fromEntityId);
              const to = byId.get(link.toEntityId);
              if (!from || !to) return null;
              return (
                <CrowConnector
                  key={link.id}
                  link={link}
                  from={from}
                  to={to}
                  lane={link.lane}
                  selected={selection.includes(link.relId)}
                  obstacles={obstacles}
                  tool={tool}
                  toWorld={toWorld}
                  handleLayer={handleLayer}
                  onSelect={(event) => tool === 'pan' ? drag.beginPan(event.clientX, event.clientY) : state.setSelection([link.relId])}
                  onKeyboardSelect={() => state.setSelection([link.relId])}
                  onBendChange={(relId, bend) => state.updateRelationship(relId,
                    { ...(bend ? { bendX: bend.x, bendY: bend.y } : { bendX: undefined, bendY: undefined }), routePoints: undefined }, true)}
                  onRouteChange={(relId, routePoints) => state.updateRelationship(relId,
                    { routePoints, bendX: undefined, bendY: undefined }, true)}
                />
              );
            })}
          </g>

          <g className="layer-tables">
            {positioned.map((table) => {
              const height = tableHeight(table);
              const isSelected = selection.includes(table.entityId);
              return (
                <g
                  key={table.entityId}
                  transform={`translate(${table.x} ${table.y})`}
                  onPointerDown={handleTablePointerDown(table.entityId)}
                  role="group"
                  tabIndex={-1}
                  aria-label={`Table ${table.name}`}
                  data-node-id={table.entityId}
                  data-testid={`table-${table.name}`}
                >
                  <title>{table.name + (table.weak ? ' (weak entity)' : ' entity table')}</title>
                  <rect
                    className="node__body"
                    width={table.width}
                    height={height}
                    style={table.weak ? { strokeDasharray: '6 4' } : undefined}
                  />
                  <line
                    className="leg"
                    x1={0}
                    y1={CROW_HEADER_HEIGHT}
                    x2={table.width}
                    y2={CROW_HEADER_HEIGHT}
                  />
                  <g role="button" tabIndex={-1} aria-label={`Table ${table.name}`}>
                  <rect className="hit-target crow-row__hit" width={table.width} height={CROW_HEADER_HEIGHT} />
                  <text className="crow-table__name" x={10} y={CROW_HEADER_HEIGHT / 2}>
                    {table.name}
                    {table.weak ? ' (weak)' : ''}
                  </text>
                  </g>

                  {table.rows.map((row, index) => {
                    const y = CROW_HEADER_HEIGHT + index * CROW_ROW_HEIGHT + CROW_ROW_HEIGHT / 2;
                    return (
                      <g key={row.id} role="button" tabIndex={0}
                        className={'crow-row' + (row.attributeId ? ' crow-row--editable' : '') +
                          (tool === 'connect' ? ' crow-row--connectable' : '') +
                          (connectFrom?.entityId === table.entityId && connectFrom.columnId === row.id ? ' crow-row--connecting' : '')}
                        aria-label={tool === 'connect' ? `Connect ${table.name}.${row.name}` :
                          row.attributeId ? `Edit attribute ${row.name}` : `Generated ${row.fk ? 'foreign key' : 'key'} ${row.name}`}
                        data-attribute-id={row.attributeId ?? undefined}
                        data-column-id={row.id}
                        aria-pressed={tool === 'connect' ? connectFrom?.entityId === table.entityId && connectFrom.columnId === row.id : undefined}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter' && event.key !== ' ') return;
                          event.preventDefault(); event.stopPropagation();
                          if (tool === 'connect') chooseColumn({ entityId: table.entityId, columnId: row.id });
                          else state.setSelection([row.attributeId ?? table.entityId]);
                        }}
                        onPointerUp={(event) => { if (tool === 'connect') event.preventDefault(); }}
                        onPointerDown={(event) => {
                          if (event.button !== 0) return;
                          event.stopPropagation();
                          if (tool === 'pan') { drag.beginPan(event.clientX, event.clientY); return; }
                          if (tool === 'connect') {
                            if (event.button !== 0) return;
                            event.preventDefault();
                            const end = { entityId: table.entityId, columnId: row.id };
                            connectionPress.current = { x: event.clientX, y: event.clientY, end };
                            setPointer(toWorld(event.clientX, event.clientY));
                            if (!connectFrom) chooseColumn(end);
                            return;
                          }
                          state.setSelection([row.attributeId ?? table.entityId]);
                        }}>
                        <title>{row.name + (row.attributeId ? ' — editable attribute' : ' — generated ' + (row.fk ? 'foreign key' : 'primary key')) +
                          (row.generatedKey ? '. Primary key generated; mark this attribute as Key to make it explicit' : '') +
                          (row.references ? '. Type ' + row.type + ' is inherited from ' + row.references.label :
                            '. Type ' + row.type + (doc.attributes.find((a) => a.id === row.attributeId)?.dataType ? ' is chosen in Properties' : ' is inferred from its name')) + '.'}</title>
                        <rect className="hit-target crow-row__hit" width={table.width} height={CROW_ROW_HEIGHT}
                          y={y - CROW_ROW_HEIGHT / 2} />
                        {tool === 'connect' ? <g className="connection-ports" pointerEvents="none" aria-hidden="true">
                          <circle cx={0} cy={y} r={5} /><circle cx={table.width} cy={y} r={5} />
                        </g> : null}
                        <text className="crow-row__key" x={10} y={y}>
                          <tspan style={row.pk && row.fk ? { fontSize: 10 } : undefined}>{row.pk && row.fk ? 'PK/FK' : row.pk ? 'PK' : row.fk ? 'FK' : ''}</tspan>
                        </text>
                        <text
                          className={`crow-row__name${row.pk ? ' crow-row__name--pk' : ''}`}
                          x={CROW_NAME_X}
                          y={y}
                        >
                          {row.name}
                        </text>
                        <text className="crow-row__type" x={table.width - 10} y={y}>
                          {row.type}
                        </text>
                        {index < table.rows.length - 1 ? (
                          <line
                            className="crow-row__rule"
                            x1={0}
                            y1={CROW_HEADER_HEIGHT + (index + 1) * CROW_ROW_HEIGHT}
                            x2={table.width}
                            y2={CROW_HEADER_HEIGHT + (index + 1) * CROW_ROW_HEIGHT}
                          />
                        ) : null}
                        {row.attributeId && selection.includes(row.attributeId) ? <rect className="selection-ring"
                          x={2} y={y - CROW_ROW_HEIGHT / 2 + 2} width={table.width - 4} height={CROW_ROW_HEIGHT - 4} /> : null}
                      </g>
                    );
                  })}

                  {isSelected ? (
                    <rect className="selection-ring" x={-5} y={-5} width={table.width + 10} height={height + 10} />
                  ) : null}
                </g>
              );
            })}
          </g>
          <g className="layer-bend-handles" ref={setHandleLayer} />
          {connectFrom && pointer ? (() => {
            const table = byId.get(connectFrom.entityId);
            if (!table) return null;
            if (pointer.x >= table.x && pointer.x <= table.x + table.width &&
                Math.abs(pointer.y - rowCenter(table, connectFrom.columnId)) <= CROW_ROW_HEIGHT / 2) return null;
            const x = table.x + (pointer.x >= table.x + table.width / 2 ? table.width : 0);
            const y = rowCenter(table, connectFrom.columnId);
            return <path className="connect-preview" d={`M${x} ${y} H${x + (x > table.x ? 36 : -36)} V${pointer.y} H${pointer.x}`} />;
          })() : null}

          {marqueeBox ? (
            <path
              className="marquee"
              d={`M${Math.min(marqueeBox.from.x, marqueeBox.to.x)} ${Math.min(marqueeBox.from.y, marqueeBox.to.y)}
                  H${Math.max(marqueeBox.from.x, marqueeBox.to.x)}
                  V${Math.max(marqueeBox.from.y, marqueeBox.to.y)}
                  H${Math.min(marqueeBox.from.x, marqueeBox.to.x)} Z`}
            />
          ) : null}

          <PeerCursors peers={peers} view="crowfoot" />
        </g>
      </svg>

      {emptyState ?? (isEmpty ? (
        <div className="canvas-empty">
          <div className="canvas-empty__card">
            <h2 className="canvas-empty__title">No tables yet</h2>
            <p className="canvas-empty__body">
              This view draws each entity as a table. Add an entity and it appears here with its key
              attributes as the primary key.
            </p>
            {emptyActions}
          </div>
        </div>
      ) : null)}

      {tool === 'connect' ? <div className="canvas-status" role="status">
        {connectFrom ? 'Choose the second attribute' : 'Choose an attribute, then another. You can also drag between rows.'}
        {connectFrom ? <button className="btn btn--ghost" type="button" onClick={() => { setConnectFrom(null); setPointer(null); }}>Cancel connection</button> : null}
      </div> : null}
    </div>
  );
}

function shorten(value: string, length: number): string {
  return value.length > length ? value.slice(0, length - 1) + '…' : value;
}

/**
 * Draws one relationship line between two tables with its ratio written clearly.
 *
 * The connector is selectable so it can be deleted. A crow's-foot view where a
 * relationship can be created but never removed is a trap: the only way out is
 * to go back to Chen, find the diamond, and delete it there.
 */
function CrowConnector({
  link,
  from,
  to,
  lane,
  selected,
  onSelect,
  onKeyboardSelect,
  obstacles,
  onBendChange,
  onRouteChange,
  toWorld,
  handleLayer,
  tool,
}: {
  link: CrowLink;
  from: CrowTable;
  to: CrowTable;
  lane: number;
  selected: boolean;
  onSelect: (event: React.PointerEvent) => void;
  onKeyboardSelect: () => void;
  /** Every table in the drawing, so a connector can route around the others. */
  obstacles: Obstacle[];
  /** Places the connector's corner, in drawing coordinates. */
  onBendChange?: (relId: string, bend: { x: number; y: number } | null) => void;
  onRouteChange: (relId: string, points: RoutePoint[]) => void;
  toWorld: (clientX: number, clientY: number) => Point;
  handleLayer: SVGGElement | null;
  tool: EditorState['tool'];
}) {
  const [preview, setPreview] = useState<Point | null>(null);
  const [previewPoints, setPreviewPoints] = useState<RoutePoint[] | null>(null);
  const [dragAxis, setDragAxis] = useState<'horizontal' | 'vertical' | null>(null);
  const [showCorner, setShowCorner] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const cancelDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelDrag.current?.(), []);
  useEffect(() => { if (!selected || tool !== 'select') cancelDrag.current?.(); }, [selected, tool]);
  useEffect(() => { if (!selected) setShowCorner(false); }, [selected]);
  // The two tables this connector starts and ends at are not obstacles: leaving
  // a row means crossing the table it belongs to, which is how a connector is
  // drawn rather than a flaw.
  const route = routeColumns(from, link.fromColumnId, to, link.toColumnId, lane,
    obstacles.filter((rect) => !(rect.minX === from.x && rect.minY === from.y) &&
      !(rect.minX === to.x && rect.minY === to.y)), link.route, preview ?? link.bend ?? null,
    previewPoints ?? link.routePoints);
  const ratioWidth = link.ratio.length * 10 + 20;
  const caption = placeRouteCaption(route, link.label, link.ratio);
  const ratioLeft = caption.x - (caption.labelAnchor === 'start' ? 10 :
    caption.labelAnchor === 'end' ? ratioWidth - 10 : ratioWidth / 2);
  const stubs = { start: Math.abs(route.guard.aStub.x - route.a.x), end: Math.abs(route.guard.bStub.x - route.b.x) };

  /** Move a segment along its normal, or the optional keyboard-selected corner. */
  const startBendDrag = (event: React.PointerEvent, handle?: Point, segmentIndex?: number) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    if (tool === 'pan') { onSelect(event); return; }
    if (tool !== 'select' || !onBendChange) return;
    event.preventDefault();
    cancelDrag.current?.();
    const origin = handle ?? {
      x: Math.round((route.a.x + route.b.x) / 2),
      y: Math.round((route.a.y + route.b.y) / 2),
    };
    const start = toWorld(event.clientX, event.clientY);
    const offset = { x: origin.x - start.x, y: origin.y - start.y };
    const press = { x: event.clientX, y: event.clientY };
    let moved = false;
    let final: Point | null = null;
    let finalPoints: RoutePoint[] | null = null;
    const axis = segmentIndex === undefined ? null :
      route.points[segmentIndex]!.y === route.points[segmentIndex + 1]!.y ? 'horizontal' : 'vertical';
    const pointerId = event.pointerId;
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      if (!moved && Math.hypot(moveEvent.clientX - press.x, moveEvent.clientY - press.y) < 4) return;
      moved = true;
      const now = toWorld(moveEvent.clientX, moveEvent.clientY);
      if (segmentIndex !== undefined) {
        const points = moveRouteSegment(route.points, segmentIndex,
          axis === 'horizontal' ? now.y - start.y : now.x - start.x, stubs);
        const safe = isRouteSafe(points, route.guard);
        setBlocked(!safe);
        if (!safe) return;
        finalPoints = points.slice(1, -1);
        if (finalPoints.length === 1) {
          // Keep a single L-shaped corner valid in the saved interior-vertex format.
          finalPoints.push({ ...finalPoints[0]! });
        } else if (finalPoints.length === 0) {
          const a = points[0]!, b = points.at(-1)!;
          finalPoints = [1 / 3, 2 / 3].map(t => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }));
        }
        setPreviewPoints(finalPoints);
        setDragAxis(axis);
        return;
      }
      const bend = { x: Math.round(now.x + offset.x), y: Math.round(now.y + offset.y) };
      const candidate = routeColumns(from, link.fromColumnId, to, link.toColumnId, lane,
        obstacles, link.route, bend);
      setBlocked(!candidate.manualAccepted);
      if (candidate.manualAccepted) { final = bend; setPreview(final); }
    };
    const cancel = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key);
      cancelDrag.current = null;
      setPreview(null);
      setPreviewPoints(null);
      setDragAxis(null);
      setBlocked(false);
    };
    const up = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      const point = final;
      const points = finalPoints;
      cancel();
      if (points) { onRouteChange(link.relId, points); return; }
      if (point && (point.x !== origin.x || point.y !== origin.y)) onBendChange(link.relId, point);
    };
    const key = (keyEvent: KeyboardEvent) => { if (keyEvent.key === 'Escape') cancel(); };
    cancelDrag.current = cancel;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
  };

  return (
    <g
      className={`crow-link${selected ? ' crow-link--selected' : ''}${preview || previewPoints ? ' crow-link--dragging' : ''}${blocked ? ' crow-link--blocked' : ''}`}
      data-drag-axis={dragAxis ?? undefined}
      role="button"
      tabIndex={0}
      aria-label={`Relationship ${link.label}, ${link.ratio}, ${from.name}.${from.rows.find((r) => r.id === link.fromColumnId)?.name} to ${to.name}.${to.rows.find((r) => r.id === link.toColumnId)?.name}`}
      data-testid={`crow-link-${link.relId}`}
      data-selection-id={link.relId}
      data-from-column={link.fromColumnId}
      data-to-column={link.toColumnId}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); setShowCorner(true); onKeyboardSelect();
        }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        event.currentTarget.focus({ preventScroll: true });
        setShowCorner(false);
        onSelect(event);
      }}
    >
      <title>Drag a segment with the double-arrow cursor to move it. Click to select.</title>
      {/* Symbol stubs can select the relationship but cannot be dragged. */}
      <path className="crow-link__hit" data-route-fixed="true"
        d={`M${route.a.x} ${route.a.y} L${route.guard.aStub.x} ${route.guard.aStub.y}`} />
      <path className="crow-link__hit" data-route-fixed="true"
        d={`M${route.guard.bStub.x} ${route.guard.bStub.y} L${route.b.x} ${route.b.y}`} />
      {/* A wide transparent band makes the thin line easy to hit, the same as
          the relationship lines in the Chen view. */}
      {route.points.slice(1).map((point, index) => {
        const previous = route.points[index]!;
        const axis = previous.y === point.y ? 'horizontal' : 'vertical';
        const start = index === 0 ? route.guard.aStub : previous;
        const end = index === route.points.length - 2 ? route.guard.bStub : point;
        const fixed = start.x === end.x && start.y === end.y;
        return <path key={index} className={`crow-link__hit crow-link__hit--${axis}`}
          data-route-axis={axis} d={`M${start.x} ${start.y} L${end.x} ${end.y}`}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.stopPropagation();
            event.currentTarget.closest<SVGGElement>('.crow-link')?.focus({ preventScroll: true });
            setShowCorner(false);
            onSelect(event);
            if (tool === 'select' && !fixed) startBendDrag(event, undefined, index);
          }} />;
      })}
      <path className="leg crow-link__path" d={route.path} />
      <CardinalityMarker origin={route.a} toward={route.aToward} many={link.fromMany} required={link.fromMandatory}
        scale={Math.min(1, stubs.start / ENDPOINT_STUB)} />
      <CardinalityMarker origin={route.b} toward={route.bToward} many={link.toMany} required={link.toMandatory}
        scale={Math.min(1, stubs.end / ENDPOINT_STUB)} />
      {/* The ratio, stated rather than implied. */}
      <rect className="crow-link__ratio-background" x={ratioLeft} y={caption.y - 14}
        width={ratioWidth} height={28} rx={4} />
      <text
        className="crow-link__ratio"
        x={caption.x}
        y={caption.y}
        textAnchor={caption.labelAnchor}
        dominantBaseline="middle"
      >
        {link.ratio}
      </text>
      {link.label ? (
        <text
          className="crow-link__label"
          x={caption.x}
          y={caption.y - 25}
          textAnchor={caption.labelAnchor}
          dominantBaseline="middle"
        >
          {shorten(link.label, 24)}
        </text>
      ) : null}
      {/*
        The optional keyboard-selected corner is above the tables and captions.
      */}
      {selected && showCorner && !link.routePoints && !previewPoints && onBendChange && handleLayer ? createPortal(
        <>
          <circle
            className="crow-link__bend-hit"
            cx={route.handle?.x ?? (route.a.x + route.b.x) / 2}
            cy={route.handle?.y ?? (route.a.y + route.b.y) / 2}
            r={14}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.stopPropagation();
              startBendDrag(event, route.handle);
            }}
          />
          <circle
            className="crow-link__bend"
            role="button"
            tabIndex={0}
            aria-label="Move relationship bend"
            cx={route.handle?.x ?? (route.a.x + route.b.x) / 2}
            cy={route.handle?.y ?? (route.a.y + route.b.y) / 2}
            r={5}
            onDoubleClick={() => onBendChange(link.relId, null)}
            onKeyDown={(event) => {
              if (event.key === 'Delete' || event.key === 'Backspace') {
                event.preventDefault(); event.stopPropagation(); onBendChange(link.relId, null);
              }
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.stopPropagation();
              startBendDrag(event, route.handle);
            }}
          />
        </>, handleLayer
      ) : null}
    </g>
  );
}
