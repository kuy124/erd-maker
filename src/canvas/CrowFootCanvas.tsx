/**
 * The crow's-foot canvas.
 *
 * A second renderer over the same document, not a second model. Entities become
 * tables with PK/FK rows; relationships become connectors whose foot is drawn
 * at the many end.
 *
 * The connector shapes are the part that has to be right: a crow's foot is
 * three short lines fanning out, a "one" end is a single perpendicular bar, and
 * a mandatory (min ≥ 1) end adds a second bar. Getting the geometry wrong here
 * is the difference between a diagram a database course accepts and one it does
 * not.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CROW_HEADER_HEIGHT,
  CROW_ROW_HEIGHT,
  CROW_WIDTH,
  deriveLinks,
  deriveTables,
  routeColumns,
  rowCenter,
  tableHeight,
  type ColumnEndpoint,
  type CrowLink,
  type CrowTable,
} from '../model/crowfoot';
import type { EditorState } from '../state/useEditor';
import { useDrag, usePeerCursor } from './useDrag';
import { CardinalityMarker, PeerCursors } from './NodeShapes';

interface Props {
  state: EditorState;
  svgRef: React.MutableRefObject<SVGSVGElement | null>;
  emptyActions?: React.ReactNode;
}

export function CrowFootCanvas({ state, svgRef, emptyActions }: Props) {
  const { doc, viewport, selection, tool, peers } = state;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 1200, height: 800 });
  const [connectFrom, setConnectFrom] = useState<ColumnEndpoint | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const connectionPress = useRef<{ x: number; y: number; end: ColumnEndpoint } | null>(null);

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
    onCommit: (id, x, y) => state.updateEntity(id, { x, y }),
    onPan: (x, y) => state.setViewport((v) => ({ ...v, x, y })),
    viewport,
    panMode: tool === 'pan',
  });

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
      event.stopPropagation();
      if (tool === 'pan') { drag.beginPan(event.clientX, event.clientY); return; }
      if (tool === 'connect') return;
      state.setSelection(id);
      const world = toWorld(event.clientX, event.clientY);
      const table = doc.entities.find((e) => e.id === id);
      if (table) drag.beginNodeDrag(id, world.x, world.y, table.x, table.y);
    },
    [tool, state, toWorld, doc.entities, drag],
  );

  const handleBackgroundPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (tool === 'connect') { setConnectFrom(null); setPointer(null); }
      if (tool !== 'pan' && event.button === 0) state.setSelection(null);
      drag.beginPan(event.clientX, event.clientY);
    },
    [tool, state, drag],
  );

  const handleWheel = useCallback(
    (event: React.WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      state.setViewport((v) => {
        const nextZoom = Math.min(3, Math.max(0.25, v.zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
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

  // Render the dragged table at its in-flight position.
  const positioned = useMemo(() => {
    const active = drag.drag;
    return tables.map((table) =>
      active && active.moved && active.id === table.entityId
        ? { ...table, x: active.x, y: active.y }
        : table,
    );
  }, [tables, drag.drag]);

  const byId = useMemo(() => new Map(positioned.map((t) => [t.entityId, t])), [positioned]);

  const isEmpty = positioned.length === 0;

  return (
    <div
      className="canvas-wrap"
      data-tool={tool}
      ref={containerRef}
      onPointerDown={handleBackgroundPointerDown}
      onWheel={handleWheel}
    >
      <svg
        ref={svgRef}
        className="canvas"
        width={size.width}
        height={size.height}
        role="application"
        aria-label="Crow's-foot table diagram canvas"
        data-testid="canvas"
        tabIndex={-1}
      >
        {/* `data-viewport` marks the pan and zoom group; the exporter resets it. */}
        <g
          data-viewport="true"
          transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}
        >
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
                  selected={selection === link.relId}
                  onSelect={(event) => tool === 'pan' ? drag.beginPan(event.clientX, event.clientY) : state.setSelection(link.relId)}
                  onKeyboardSelect={() => state.setSelection(link.relId)}
                />
              );
            })}
          </g>

          <g className="layer-tables">
            {positioned.map((table) => {
              const height = tableHeight(table);
              const isSelected = selection === table.entityId;
              return (
                <g
                  key={table.entityId}
                  transform={`translate(${table.x} ${table.y})`}
                  onPointerDown={handleTablePointerDown(table.entityId)}
                  role="group"
                  aria-label={`Table ${table.name}`}
                  data-node-id={table.entityId}
                  data-testid={`table-${table.name}`}
                >
                  <title>{table.name + (table.weak ? ' (weak entity)' : ' entity table')}</title>
                  <rect
                    className="node__body"
                    width={CROW_WIDTH}
                    height={height}
                    style={table.weak ? { strokeDasharray: '6 4' } : undefined}
                  />
                  <line
                    className="leg"
                    x1={0}
                    y1={CROW_HEADER_HEIGHT}
                    x2={CROW_WIDTH}
                    y2={CROW_HEADER_HEIGHT}
                  />
                  <g role="button" tabIndex={-1} aria-label={`Table ${table.name}`}>
                  <rect className="hit-target crow-row__hit" width={CROW_WIDTH} height={CROW_HEADER_HEIGHT} />
                  <text className="crow-table__name" x={10} y={CROW_HEADER_HEIGHT / 2}>
                    {shorten(table.name, table.weak ? 26 : 34)}
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
                          else state.setSelection(row.attributeId ?? table.entityId);
                        }}
                        onPointerUp={(event) => { if (tool === 'connect') event.preventDefault(); }}
                        onPointerDown={(event) => {
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
                          state.setSelection(row.attributeId ?? table.entityId);
                        }}>
                        <title>{row.name + (row.attributeId ? ' — editable attribute' : ' — generated ' + (row.fk ? 'foreign key' : 'primary key')) +
                          (row.generatedKey ? '. Primary key generated; mark this attribute as Key to make it explicit' : '') +
                          (row.references ? '. References ' + row.references.label : '') + '. Type ' + row.type + ' is inferred from its name or referenced key.'}</title>
                        <rect className="hit-target crow-row__hit" width={CROW_WIDTH} height={CROW_ROW_HEIGHT}
                          y={y - CROW_ROW_HEIGHT / 2} />
                        {tool === 'connect' ? <g className="connection-ports" pointerEvents="none" aria-hidden="true">
                          <circle cx={0} cy={y} r={5} /><circle cx={CROW_WIDTH} cy={y} r={5} />
                        </g> : null}
                        <text className="crow-row__key" x={10} y={row.attributeId && !row.generatedKey ? y : y - 7}>
                          <tspan style={row.pk && row.fk ? { fontSize: 10 } : undefined}>{row.pk && row.fk ? 'PK/FK' : row.pk ? 'PK' : row.fk ? 'FK' : ''}</tspan>
                        </text>
                        {!row.attributeId || row.generatedKey ? <text className="crow-row__key" x={10} y={y + 9}>gen</text> : null}
                        <text
                          className={`crow-row__name${row.pk ? ' crow-row__name--pk' : ''}`}
                          x={46}
                          y={y}
                        >
                          {shorten(row.name, 18)}
                        </text>
                        <text className="crow-row__type" x={CROW_WIDTH - 10} y={y}>
                          {row.type}
                        </text>
                        {index < table.rows.length - 1 ? (
                          <line
                            className="crow-row__rule"
                            x1={0}
                            y1={CROW_HEADER_HEIGHT + (index + 1) * CROW_ROW_HEIGHT}
                            x2={CROW_WIDTH}
                            y2={CROW_HEADER_HEIGHT + (index + 1) * CROW_ROW_HEIGHT}
                          />
                        ) : null}
                        {selection === row.attributeId && row.attributeId ? <rect className="selection-ring"
                          x={2} y={y - CROW_ROW_HEIGHT / 2 + 2} width={CROW_WIDTH - 4} height={CROW_ROW_HEIGHT - 4} /> : null}
                      </g>
                    );
                  })}

                  {isSelected ? (
                    <rect className="selection-ring" x={-5} y={-5} width={CROW_WIDTH + 10} height={height + 10} />
                  ) : null}
                </g>
              );
            })}
          </g>
          {connectFrom && pointer ? (() => {
            const table = byId.get(connectFrom.entityId);
            if (!table) return null;
            if (pointer.x >= table.x && pointer.x <= table.x + CROW_WIDTH &&
                Math.abs(pointer.y - rowCenter(table, connectFrom.columnId)) <= CROW_ROW_HEIGHT / 2) return null;
            const x = table.x + (pointer.x >= table.x + CROW_WIDTH / 2 ? CROW_WIDTH : 0);
            const y = rowCenter(table, connectFrom.columnId);
            return <path className="connect-preview" d={`M${x} ${y} H${x + (x > table.x ? 36 : -36)} V${pointer.y} H${pointer.x}`} />;
          })() : null}

          <PeerCursors peers={peers} />
        </g>
      </svg>

      {isEmpty ? (
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
      ) : null}

      <div className="canvas-status" role="status">
        {tool === 'connect' ? (connectFrom ? 'Choose the second attribute' : 'Choose an attribute, then another. You can also drag between rows.') : "Crow's-foot view"}
        <span aria-hidden="true">·</span>
        <span>{positioned.length} {positioned.length === 1 ? 'table' : 'tables'}</span>
        {connectFrom ? <button className="btn btn--ghost" type="button" onClick={() => { setConnectFrom(null); setPointer(null); }}>Cancel connection</button> :
          <span className="table-legend">· gen = generated · Types inferred</span>}
      </div>
    </div>
  );
}

function shorten(value: string, length: number): string {
  return value.length > length ? value.slice(0, length - 1) + '…' : value;
}

/**
 * Draws one relationship line between two tables, with a crow's foot at the
 * many end, a single bar at the one end, and the ratio written on the line.
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
}: {
  link: CrowLink;
  from: CrowTable;
  to: CrowTable;
  lane: number;
  selected: boolean;
  onSelect: (event: React.PointerEvent) => void;
  onKeyboardSelect: () => void;
}) {
  const route = routeColumns(from, link.fromColumnId, to, link.toColumnId, lane);

  return (
    <g
      className={`crow-link${selected ? ' crow-link--selected' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`Relationship ${link.label}, ${link.ratio}, ${from.name}.${from.rows.find((r) => r.id === link.fromColumnId)?.name} to ${to.name}.${to.rows.find((r) => r.id === link.toColumnId)?.name}`}
      data-testid={`crow-link-${link.relId}`}
      data-from-column={link.fromColumnId}
      data-to-column={link.toColumnId}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onKeyboardSelect(); }
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        onSelect(event);
      }}
    >
      {/* A wide transparent band makes the thin line easy to hit, the same as
          the relationship lines in the Chen view. */}
      <path className="crow-link__hit" d={route.path} />
      <path className="leg crow-link__path" d={route.path} />
      <CardinalityMarker origin={route.a} toward={route.aToward}
        many={link.fromMany} required={link.fromMandatory} />
      <CardinalityMarker origin={route.b} toward={route.bToward}
        many={link.toMany} required={link.toMandatory} />
      {/* The ratio, stated rather than implied. */}
      <text
        className="crow-link__ratio"
        x={route.label.x}
        y={route.label.y}
        textAnchor={route.labelAnchor}
        dominantBaseline="middle"
      >
        {link.ratio}
      </text>
      {link.label ? (
        <text
          className="crow-link__label"
          x={route.label.x}
          y={route.label.y - 16}
          textAnchor={route.labelAnchor}
          dominantBaseline="middle"
        >
          {shorten(link.label, 24)}
        </text>
      ) : null}
    </g>
  );
}
