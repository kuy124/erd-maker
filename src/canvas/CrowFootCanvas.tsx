/**
 * The crow's-foot canvas.
 *
 * A second renderer over the same document, not a second model. Entities become
 * tables with PK/FK rows; relationships use crow's-foot symbols and explicit
 * a cardinality label at each table end. Endpoint stubs stay protected during dragging.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ENDPOINT_STUB, isRouteSafe, moveRouteSegment, placeEndpointLabels, placeRouteCaption, roundedRoutePath, splitRouteSegment, symbolBoxes, type RoutePoint } from '../model/connectorRouting';
import { useCanvasZoom } from './useCanvasZoom';
import { useDepartures } from './departures';
import { CommentPins, useCommentPlacement } from './CommentPins';
import {
  CROW_HEADER_HEIGHT,
  CROW_ROW_HEIGHT,
  CROW_NAME_X,
  deriveLinks,
  deriveTables,
  routeColumns,
  routeLinks,
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
  onFollowPeer?: (id: number) => void;
  followActive?: boolean;
  onCommentSelect: (id: string) => void;
}

export function CrowFootCanvas({ state, svgRef, emptyActions, emptyState, onTablePositions, onFollowPeer, followActive, onCommentSelect }: Props) {
  const { doc, viewport, selection, tool, peers } = state;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 1200, height: 800 });
  const [connectFrom, setConnectFrom] = useState<ColumnEndpoint | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const connectionPress = useRef<{ x: number; y: number; end: ColumnEndpoint } | null>(null);
  const [handleLayer, setHandleLayer] = useState<SVGGElement | null>(null);
  const [hoveredLine, setHoveredLine] = useState<string | null>(null);

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
    all.findIndex((other) => other.id === link.id) === index), [doc]);

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

  // Auto-follow the dragged table offscreen.
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

  // Show a grabbing cursor on the canvas while we carry a table.
  useEffect(() => {
    containerRef.current?.classList.toggle('is-dragging', Boolean(drag.drag?.moved));
  }, [drag.drag]);

  // Tell peers while we carry a table, so its shape follows live before drop.
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

  // The table view had no presence at all; moving the mouse is now enough to be seen.
  usePeerCursor(toWorld, state.awareness, state.pointer, followActive ?? false);

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

  const commentPlacement = useCommentPlacement(state, toWorld);

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

// Render every dragged table at its in-flight position. Peer drags (carried
  // tables in the same notation) are folded in too, so a carried table follows
  // the peer's cursor live before the drop.
  const positioned = useMemo(() => {
    const entries: { start: Map<string, { x: number; y: number }>; dx: number; dy: number }[] = [];
    const active = drag.drag;
    if (active?.moved) entries.push({ start: active.start, dx: active.dx, dy: active.dy });
    for (const peer of peers) {
      if (peer.view !== 'crowfoot') continue;
      const d = peer.dragging;
      if (!d) continue;
      entries.push({ start: new Map(Object.entries(d.start)), dx: d.dx, dy: d.dy });
    }
    if (entries.length === 0) return tables;
    return tables.map((table) => {
      let x = table.x; let y = table.y;
      for (const entry of entries) {
        const s = entry.start.get(table.entityId);
        if (s) { x = s.x + entry.dx; y = s.y + entry.dy; }
      }
      if (x === table.x && y === table.y) return table;
      return { ...table, x, y };
    });
  }, [tables, drag.drag, peers]);

  const byId = useMemo(() => new Map(positioned.map((t) => [t.entityId, t])), [positioned]);

  /**
   * Tables that have left the paper since the last change, held a moment
   * longer so they dissolve instead of snapping out of existence.
   */
  const departingTables = useDepartures(positioned, (table) => table.entityId);
  // Where a table is, so a peer's aim is drawn around the table it names.
  const boundsOf = useCallback((id: string) => {
    const table = byId.get(id);
    return table ? { x: table.x, y: table.y, w: table.width, h: tableHeight(table) } : null;
  }, [byId]);
  // Where every table is drawn, so a connector can be kept off them.
  const obstacles = useMemo(() => positioned.map(tableObstacle), [positioned]);
  const routes = useMemo(() => routeLinks(positioned, links), [positioned, links]);

  const isEmpty = positioned.length === 0;

  // The connectors that were already drawn when this view opened. Anything
  // that arrives later inks itself in; a link that was already on the paper
  // never re-draws when a table moves.
  const settledLinks = useRef<Set<string> | null>(null);
  if (!settledLinks.current && !isEmpty) settledLinks.current = new Set(links.map((link) => link.id));
  const linkEnters = (id: string) => settledLinks.current !== null && !settledLinks.current.has(id);

  return (
    <div
      className="canvas-wrap"
      data-tool={tool}
      ref={containerRef}
      onPointerMove={event => setHoveredLine((event.target as Element).closest('[data-route-owner]')?.getAttribute('data-route-owner') ?? null)}
      onPointerLeave={() => setHoveredLine(null)}
    >
      <svg
        {...commentPlacement}
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
                  automaticRoute={routes.get(link.id)!}
                  fresh={linkEnters(link.id)}
                  selected={selection.includes(link.relId)}
                  hovered={hoveredLine === link.relId}
                  obstacles={obstacles}
                  tool={tool}
                  zoom={viewport.zoom}
                  toWorld={toWorld}
                  handleLayer={handleLayer}
                  onSelect={(event) => tool === 'pan' ? drag.beginPan(event.clientX, event.clientY) : state.setSelection([link.relId])}
                  onKeyboardSelect={() => state.setSelection([link.relId])}
                  onRouteChange={(relId, routePoints) => state.updateRelationship(relId,
                    { routePoints, bendX: undefined, bendY: undefined }, true)}
                  onResetRoute={relId => state.updateRelationship(relId,
                    { route: 'auto', routePoints: undefined, bendX: undefined, bendY: undefined }, true)}
                />
              );
            })}
          </g>

          <g className="layer-tables">
            {departingTables.map((table) => (
              <g
                key={`departing-${table.entityId}`}
                transform={`translate(${table.x} ${table.y})`}
                aria-hidden="true"
                style={{ pointerEvents: 'none' }}
              >
                <g className="node--exit">
                  <rect
                    className="node__body"
                    width={table.width}
                    height={tableHeight(table)}
                    style={table.weak ? { strokeDasharray: '6 4' } : undefined}
                  />
                  <line
                    className="leg"
                    x1={0}
                    y1={CROW_HEADER_HEIGHT}
                    x2={table.width}
                    y2={CROW_HEADER_HEIGHT}
                  />
                  <text className="crow-table__name" x={CROW_NAME_X} y={CROW_HEADER_HEIGHT / 2}>
                    {table.name}
                    {table.weak ? ' (weak)' : table.associative ? ' (associative)' : ''}
                  </text>
                </g>
              </g>
            ))}
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
                    {table.weak ? ' (weak)' : table.associative ? ' (associative)' : ''}
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
                          else state.setSelection([row.attributeId ?? row.references?.relationshipIds?.[0] ?? table.entityId]);
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
                          state.setSelection([row.attributeId ?? row.references?.relationshipIds?.[0] ?? table.entityId]);
                        }}>
                        <title>{row.name + (row.attributeId ? ' — editable attribute' : ' — generated ' + (row.fk ? 'foreign key' : 'primary key')) +
                          (row.generatedKey ? '. Primary key generated; mark this attribute as Key to make it explicit' : '') +
                          (row.fk && !row.attributeId ? '. Click to name this column' : '') +
                          (row.references ? '. Type ' + row.type + ' is inherited from ' + row.references.label :
                            '. Type ' + row.type + (doc.attributes.find((a) => a.id === row.attributeId)?.dataType ? ' is chosen in Properties' : ' is inferred from its name')) + '.'}</title>
                        <rect className="hit-target crow-row__hit" width={table.width} height={CROW_ROW_HEIGHT}
                          y={y - CROW_ROW_HEIGHT / 2} />
                        {tool === 'connect' ? <g className="connection-ports" pointerEvents="none" aria-hidden="true">
                          <circle cx={0} cy={y} r={5} /><circle cx={table.width} cy={y} r={5} />
                        </g> : null}
                        <text className="crow-row__key" x={10} y={y}>
                          <tspan style={row.pk && row.fk ? { fontSize: 10 } : undefined}>
                            {row.pk && row.fk ? 'PK/FK' : row.pk ? 'PK' : row.fk ? 'FK' : row.unique ? 'UQ' : ''}
                          </tspan>
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

          <CommentPins state={state} onSelect={onCommentSelect} />
          <PeerCursors peers={peers} view="crowfoot" boundsOf={boundsOf} onFollow={(id) => onFollowPeer?.(id)} />
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

function interiorPoints(points: RoutePoint[]): RoutePoint[] {
  const interior = points.slice(1, -1);
  if (interior.length === 1) return [interior[0]!, { ...interior[0]! }];
  if (interior.length) return interior;
  const a = points[0]!, b = points.at(-1)!;
  return [1 / 3, 2 / 3].map(t => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }));
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
  automaticRoute,
  fresh,
  selected,
  hovered,
  onSelect,
  onKeyboardSelect,
  obstacles,
  onRouteChange,
  onResetRoute,
  toWorld,
  handleLayer,
  tool,
  zoom,
}: {
  link: CrowLink;
  from: CrowTable;
  to: CrowTable;
  automaticRoute: ReturnType<typeof routeColumns>;
  /** True when the link arrived after this view opened, so it inks itself in. */
  fresh: boolean;
  selected: boolean;
  hovered: boolean;
  onSelect: (event: React.PointerEvent) => void;
  onKeyboardSelect: () => void;
  /** Every table in the drawing, so a connector can route around the others. */
  obstacles: Obstacle[];
  onRouteChange: (relId: string, points: RoutePoint[]) => void;
  onResetRoute: (relId: string) => void;
  toWorld: (clientX: number, clientY: number) => Point;
  handleLayer: SVGGElement | null;
  tool: EditorState['tool'];
  zoom: number;
}) {
  const [previewPoints, setPreviewPoints] = useState<RoutePoint[] | null>(null);
  const [dragAxis, setDragAxis] = useState<'horizontal' | 'vertical' | null>(null);
  const [blocked, setBlocked] = useState(false);
  const cancelDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelDrag.current?.(), []);
  useEffect(() => { if (!selected || tool !== 'select') cancelDrag.current?.(); }, [selected, tool]);
  // The two tables this connector starts and ends at are not obstacles: leaving
  // a row means crossing the table it belongs to, which is how a connector is
  // drawn rather than a flaw.
  const route = previewPoints ? routeColumns(from, link.fromColumnId, to, link.toColumnId, link.lane,
    obstacles.filter((rect) => !(rect.minX === from.x && rect.minY === from.y) &&
      !(rect.minX === to.x && rect.minY === to.y)), link.route, link.bend ?? null,
    previewPoints) : automaticRoute;
  const caption = placeRouteCaption(route, link.ratio);
  const endpointLabels = placeEndpointLabels(route.guard, link.ratio);
  const stubs = { start: Math.abs(route.guard.aStub.x - route.a.x), end: Math.abs(route.guard.bStub.x - route.b.x) };
  const controlBoxes = [...route.guard.obstacles, ...symbolBoxes(route.guard), caption.bounds, ...endpointLabels.map(label => label.bounds)];
  const controlClear = (point: Point, radius = 8 / zoom) => controlBoxes.every(box => point.x + radius <= box.minX ||
    point.x - radius >= box.maxX || point.y + radius <= box.minY || point.y - radius >= box.maxY);
  const resetPoint = [
    { x: caption.x, y: caption.bounds.minY - 15 / zoom },
    { x: caption.bounds.maxX + 15 / zoom, y: caption.y - 25 },
    { x: caption.bounds.minX - 15 / zoom, y: caption.y - 25 },
  ].find(point => controlClear(point, 10 / zoom)) ??
    { x: caption.x, y: Math.min(...controlBoxes.map(box => box.minY)) - 15 / zoom };

  const splitSegment = (index: number, position?: Point) => {
    if (tool !== 'select') return;
    const points = splitRouteSegment(route.points, index, route.guard, position);
    if (points) { cancelDrag.current?.(); onRouteChange(link.relId, interiorPoints(points)); }
  };

  /** Drag a whole section, or split and drag one half, perpendicular to the line. */
  const startRouteDrag = (event: React.PointerEvent, index: number, kind: 'segment' | 'insert', handle?: Point) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    if (tool === 'pan') { onSelect(event); return; }
    if (tool !== 'select') return;
    event.preventDefault();
    cancelDrag.current?.();
    onSelect(event);
    const start = toWorld(event.clientX, event.clientY);
    const origin = handle ?? start;
    const press = { x: event.clientX, y: event.clientY };
    let finalPoints: RoutePoint[] | null = null;
    const axis = route.points[index]!.y === route.points[index + 1]!.y ? 'horizontal' : 'vertical';
    const pointerId = event.pointerId;
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      if (Math.abs(axis === 'horizontal' ? moveEvent.clientY - press.y : moveEvent.clientX - press.x) < 4) {
        finalPoints = null; setPreviewPoints(null); setBlocked(false); setDragAxis(null); return;
      }
      const now = toWorld(moveEvent.clientX, moveEvent.clientY);
      const delta = axis === 'horizontal' ? now.y - start.y : now.x - start.x;
      const points = kind === 'insert' ? splitRouteSegment(route.points, index, route.guard, origin, delta, true) :
          moveRouteSegment(route.points, index, delta, stubs);
      const safe = points !== null && isRouteSafe(points, route.guard, true);
      setBlocked(!safe);
      if (!safe || !points) return;
      finalPoints = interiorPoints(points);
      setPreviewPoints(finalPoints);
      setDragAxis(axis);
    };
    const cancel = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key);
      cancelDrag.current = null;
      setPreviewPoints(null);
      setDragAxis(null);
      setBlocked(false);
    };
    const up = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      const points = finalPoints;
      cancel();
      if (points) onRouteChange(link.relId, points);
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
      className={`crow-link${selected ? ' crow-link--selected' : ''}${hovered ? ' crow-link--hovered' : ''}${previewPoints ? ' crow-link--dragging' : ''}${blocked ? ' crow-link--blocked' : ''}`}
      data-route-owner={link.relId}
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
          event.preventDefault(); onKeyboardSelect();
        }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        event.currentTarget.focus({ preventScroll: true });
        onSelect(event);
      }}
    >
      <title>Hover to reveal controls. Drag a round handle to move a section, or a square to split and move that half.</title>
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
            onSelect(event);
            if (tool === 'select' && !fixed) startRouteDrag(event, index, 'segment');
          }} />;
      })}
      <path className={`leg crow-link__path${fresh ? ' ink-in' : ''}`}
        pathLength={fresh ? 1 : undefined} d={roundedRoutePath(route.points, route.guard)} />
      <CardinalityMarker origin={route.a} toward={route.aToward} many={link.fromMany} required={link.fromMandatory}
        scale={Math.min(1, stubs.start / ENDPOINT_STUB)} />
      <CardinalityMarker origin={route.b} toward={route.bToward} many={link.toMany} required={link.toMandatory}
        scale={Math.min(1, stubs.end / ENDPOINT_STUB)} />
      {endpointLabels.map((label, index) => <g key={index} data-route-end={index === 0 ? 'from' : 'to'}>
        <rect className="crow-link__ratio-background" x={label.bounds.minX} y={label.bounds.minY}
          width={label.bounds.maxX - label.bounds.minX} height={22} rx={4} />
        <text className="crow-link__ratio" x={label.x} y={label.y} textAnchor="middle" dominantBaseline="middle">
          {label.value}
        </text>
      </g>)}
      {(selected || hovered) && tool === 'select' && handleLayer ? createPortal(<g data-route-owner={link.relId} data-selection-id={link.relId}>
        {route.points.slice(1).map((end, index) => {
          const start = route.points[index]!;
          const horizontal = start.y === end.y;
          const usableStart = index === 0 ? route.guard.aStub : start;
          const usableEnd = index === route.points.length - 2 ? route.guard.bStub : end;
          const length = Math.abs(usableEnd.x - usableStart.x) + Math.abs(usableEnd.y - usableStart.y);
          if (length < 24) return null;
          const middle = { x: (usableStart.x + usableEnd.x) / 2, y: (usableStart.y + usableEnd.y) / 2 };
          const inserts = [0.25, 0.75].map(fraction => ({ x: usableStart.x + (usableEnd.x - usableStart.x) * fraction,
            y: usableStart.y + (usableEnd.y - usableStart.y) * fraction }));
          return <g key={index}>
            {controlClear(middle) ? <g className={`crow-link__segment-handle crow-link__hit--${horizontal ? 'horizontal' : 'vertical'}`}
              role="button" tabIndex={0} aria-label={`Move ${horizontal ? 'horizontal' : 'vertical'} segment ${index + 1}`}
              transform={`translate(${middle.x} ${middle.y})`}
              onPointerDown={event => { event.currentTarget.focus({ preventScroll: true }); startRouteDrag(event, index, 'segment'); }}
              onKeyDown={event => {
                const negative = horizontal ? 'ArrowUp' : 'ArrowLeft', positive = horizontal ? 'ArrowDown' : 'ArrowRight';
                if (event.key !== negative && event.key !== positive) return;
                event.preventDefault(); event.stopPropagation();
                const points = moveRouteSegment(route.points, index, (event.key === negative ? -1 : 1) * (event.shiftKey ? 10 : 1), stubs);
                if (isRouteSafe(points, route.guard, true)) onRouteChange(link.relId, interiorPoints(points));
              }}>
              <title>Drag this section, or use arrow keys; Shift moves 10 units</title>
              <circle className="crow-link__split-hit" r={11 / zoom} />
              <circle className="crow-link__handle-body" r={5 / zoom} />
            </g> : null}
            {/* Keep insert and drag hit targets separate even when zoomed out. */}
            {length >= 40 && length * zoom >= 48 ? inserts.map((center, half) => controlClear(center) ?
              <g key={half} className={`crow-link__split crow-link__hit--${horizontal ? 'horizontal' : 'vertical'}`} role="button" tabIndex={0}
            aria-label={`Split ${horizontal ? 'horizontal' : 'vertical'} segment ${index + 1}, ${half ? 'second' : 'first'} half`}
            data-route-half={half}
            transform={`translate(${center.x} ${center.y})`}
            onPointerDown={event => startRouteDrag(event, index, 'insert', center)}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault(); event.stopPropagation(); splitSegment(index, center);
              }
            }}>
            <title>Drag to split and move this half; a click selects without reshaping. Enter adds a section.</title>
            <circle className="crow-link__split-hit" r={9 / zoom} />
            <rect className="crow-link__split-body" x={-4 / zoom} y={-4 / zoom} width={8 / zoom} height={8 / zoom} rx={1 / zoom} />
          </g> : null) : null}</g>;
        })}
        {(link.bend || link.routePoints || link.route !== 'auto') ?
          <g className="crow-link__reset" role="button" tabIndex={0} aria-label="Reset line route"
            transform={`translate(${resetPoint.x} ${resetPoint.y})`}
            onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }}
            onClick={event => { event.stopPropagation(); onResetRoute(link.relId); }}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); onResetRoute(link.relId); }
            }}>
            <title>Restore automatic routing</title>
            <rect className="crow-link__split-body" x={-10 / zoom} y={-10 / zoom} width={20 / zoom} height={20 / zoom} rx={3 / zoom} />
            <path transform={`scale(${1 / zoom})`} d="M5 -3 A6 6 0 1 0 5 3 M5 -7 V-2 H0" />
          </g> : null}
        </g>, handleLayer) : null}
    </g>
  );
}
