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
  tableHeight,
  type CrowLink,
} from '../model/crowfoot';
import type { EditorState } from '../state/useEditor';
import { useDrag } from './useDrag';

interface Props {
  state: EditorState;
  svgRef: React.MutableRefObject<SVGSVGElement | null>;
  emptyActions?: React.ReactNode;
}

export function CrowFootCanvas({ state, svgRef, emptyActions }: Props) {
  const { doc, viewport, selection, tool } = state;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 1200, height: 800 });

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

  const handleTablePointerDown = useCallback(
    (id: string) => (event: React.PointerEvent) => {
      event.stopPropagation();
      if (tool === 'pan') { drag.beginPan(event.clientX, event.clientY); return; }
      state.setSelection(id);
      const world = toWorld(event.clientX, event.clientY);
      const table = doc.entities.find((e) => e.id === id);
      if (table) drag.beginNodeDrag(id, world.x, world.y, table.x, table.y);
    },
    [tool, state, toWorld, doc.entities, drag],
  );

  const handleBackgroundPointerDown = useCallback(
    (event: React.PointerEvent) => {
      // The Connect tool behaves as Select here: this view derives its lines from
      // the Chen document rather than drawing them, so there is nothing to
      // connect, and a tool that silently did nothing would be a trap.
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
                  from={{ x: from.x, y: from.y, h: tableHeight(from) }}
                  to={{ x: to.x, y: to.y, h: tableHeight(to) }}
                  selected={selection === link.relId}
                  onSelect={(event) => tool === 'pan' ? drag.beginPan(event.clientX, event.clientY) : state.setSelection(link.relId)}
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
                      <g key={`${row.name}-${index}`} role="button" tabIndex={-1}
                        className={row.attributeId ? 'crow-row crow-row--editable' : 'crow-row'}
                        aria-label={row.attributeId ? `Edit attribute ${row.name}` : `Generated ${row.fk ? 'foreign key' : 'key'} ${row.name}`}
                        data-attribute-id={row.attributeId ?? undefined}
                        onPointerDown={(event) => {
                          event.stopPropagation();
                          if (tool === 'pan') { drag.beginPan(event.clientX, event.clientY); return; }
                          state.setSelection(row.attributeId ?? table.entityId);
                        }}>
                        <title>{row.name + (row.attributeId ? ' — editable attribute' : ' — generated ' + (row.fk ? 'foreign key' : 'primary key')) + '. Type ' + row.type + ' is inferred from the name.'}</title>
                        <rect className="hit-target crow-row__hit" width={CROW_WIDTH} height={CROW_ROW_HEIGHT}
                          y={y - CROW_ROW_HEIGHT / 2} />
                        <text className="crow-row__key" x={10} y={row.attributeId ? y : y - 7}>
                          {row.pk ? 'PK' : row.fk ? 'FK' : ''}
                        </text>
                        {!row.attributeId ? <text className="crow-row__key" x={10} y={y + 9}>gen</text> : null}
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
        Crow's-foot view
        <span aria-hidden="true">·</span>
        <span>{positioned.length} {positioned.length === 1 ? 'table' : 'tables'}</span>
        <span className="table-legend">· gen = generated · Types inferred</span>
      </div>
    </div>
  );
}

function shorten(value: string, length: number): string {
  return value.length > length ? value.slice(0, length - 1) + '…' : value;
}

interface End {
  x: number;
  y: number;
  h: number;
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
  selected,
  onSelect,
}: {
  link: CrowLink;
  from: End;
  to: End;
  selected: boolean;
  onSelect: (event: React.PointerEvent) => void;
}) {
  const fromCenter = { x: from.x + CROW_WIDTH / 2, y: from.y + from.h / 2 };
  const toCenter = { x: to.x + CROW_WIDTH / 2, y: to.y + to.h / 2 };

  // Exit sideways when the tables are side by side, vertically when stacked.
  const horizontal = Math.abs(toCenter.x - fromCenter.x) > Math.abs(toCenter.y - fromCenter.y);

  const start = horizontal
    ? { x: toCenter.x > fromCenter.x ? from.x + CROW_WIDTH : from.x, y: fromCenter.y }
    : { x: fromCenter.x, y: toCenter.y > fromCenter.y ? from.y + from.h : from.y };

  const end = horizontal
    ? { x: toCenter.x > fromCenter.x ? to.x : to.x + CROW_WIDTH, y: toCenter.y }
    : { x: toCenter.x, y: toCenter.y > fromCenter.y ? to.y : to.y + to.h };

  const direction = horizontal
    ? { x: Math.sign(end.x - start.x) || 1, y: 0 }
    : { x: 0, y: Math.sign(end.y - start.y) || 1 };

  const endDirection = { x: -direction.x, y: -direction.y };

  const perpendicular = horizontal ? { x: 0, y: 1 } : { x: 1, y: 0 };

  const fan = (origin: { x: number; y: number }, dir: { x: number; y: number }) => {
    const tip = { x: origin.x + dir.x * 14, y: origin.y + dir.y * 14 };
    const spread = 9;
    const back = { x: origin.x + dir.x * 1, y: origin.y + dir.y * 1 };
    return [
      `M${tip.x} ${tip.y} L${back.x + perpendicular.x * spread} ${back.y + perpendicular.y * spread}`,
      `M${tip.x} ${tip.y} L${back.x} ${back.y}`,
      `M${tip.x} ${tip.y} L${back.x - perpendicular.x * spread} ${back.y - perpendicular.y * spread}`,
    ].join(' ');
  };

  const bar = (origin: { x: number; y: number }, dir: { x: number; y: number }, distance: number) => {
    const c = { x: origin.x + dir.x * distance, y: origin.y + dir.y * distance };
    const half = 9;
    return `M${c.x - perpendicular.x * half} ${c.y - perpendicular.y * half} L${c.x + perpendicular.x * half} ${c.y + perpendicular.y * half}`;
  };

  const marker = (point: { x: number; y: number }, dir: { x: number; y: number }, many: boolean, required: boolean) => <>
    <path className="leg" data-cardinality={many ? 'many' : 'one'} d={many ? fan(point, dir) : bar(point, dir, 10)} fill="none" />
    {required ? <path className="leg" d={bar(point, dir, 22)} fill="none" /> :
      <circle className="leg" cx={point.x + dir.x * 22} cy={point.y + dir.y * 22} r={4} />}
  </>;

  // The label sits at the midpoint, nudged off the line so it never sits on it.
  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const labelOffset = horizontal ? 20 : 14;

  return (
    <g
      className={`crow-link${selected ? ' crow-link--selected' : ''}`}
      role="button"
      tabIndex={-1}
      aria-label={`Relationship ${link.label}, ${link.ratio}`}
      data-testid={`crow-link-${link.relId}`}
      onPointerDown={(event) => {
        event.stopPropagation();
        onSelect(event);
      }}
    >
      {/* A wide transparent band makes the thin line easy to hit, the same as
          the relationship lines in the Chen view. */}
      <line
        className="crow-link__hit"
        x1={start.x}
        y1={start.y}
        x2={end.x}
        y2={end.y}
      />
      <line className="leg" x1={start.x} y1={start.y} x2={end.x} y2={end.y} />
      {marker(start, direction, link.fromMany, link.fromMandatory)}
      {marker(end, endDirection, link.toMany, link.toMandatory)}
      {/* The ratio, stated rather than implied. */}
      <text
        className="crow-link__ratio"
        x={mid.x + (horizontal ? 0 : labelOffset)}
        y={mid.y + (horizontal ? -labelOffset : 0)}
        textAnchor="middle"
        dominantBaseline="middle"
      >
        {link.ratio}
      </text>
      {link.label ? (
        <text
          className="crow-link__label"
          x={mid.x + (horizontal ? 0 : labelOffset)}
          y={mid.y + (horizontal ? -labelOffset : 0) + (horizontal ? -14 : 14)}
          textAnchor="middle"
          dominantBaseline="middle"
        >
          {link.label}
        </text>
      ) : null}
    </g>
  );
}
