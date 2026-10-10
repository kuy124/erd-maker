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

import { useCallback, useMemo, useRef, useState } from 'react';
import { CROW_HEADER_HEIGHT, CROW_ROW_HEIGHT, CROW_WIDTH, deriveLinks, deriveTables, tableHeight } from '../model/crowfoot';
import type { EditorState } from '../state/useEditor';
import { useDrag } from './useDrag';

interface Props {
  state: EditorState;
  svgRef: React.MutableRefObject<SVGSVGElement | null>;
}

export function CrowFootCanvas({ state, svgRef }: Props) {
  const { doc, viewport, selection, tool } = state;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 1200, height: 800 });

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

  const tables = useMemo(() => deriveTables(doc), [doc]);
  const links = useMemo(() => deriveLinks(doc), [doc]);

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
      if (tool === 'pan') return;
      state.setSelection(id);
      const world = toWorld(event.clientX, event.clientY);
      const table = doc.entities.find((e) => e.id === id);
      if (table) drag.beginNodeDrag(id, world.x, world.y, table.x, table.y);
    },
    [tool, state, toWorld, doc.entities, drag],
  );

  const handleBackgroundPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (tool === 'select' && event.button === 0) state.setSelection(null);
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
      ref={(node) => {
        containerRef.current = node;
        measuredRef(node);
      }}
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
      >
        <defs>
          <marker id="crow-foot" markerWidth="10" markerHeight="10" refX="0" refY="5" orient="auto">
            <path d="M0 5 L10 0 M0 5 L10 5 M0 5 L10 10" stroke="var(--ink)" strokeWidth="1.4" fill="none" />
          </marker>
        </defs>

        <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}>
          <g className="layer-links">
            {links.map((link) => {
              const from = byId.get(link.fromEntityId);
              const to = byId.get(link.toEntityId);
              if (!from || !to) return null;
              return (
                <CrowConnector
                  key={link.id}
                  from={{ x: from.x, y: from.y, h: tableHeight(from) }}
                  to={{ x: to.x, y: to.y, h: tableHeight(to) }}
                  manyAtFrom={link.manyEntityId === link.fromEntityId}
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
                  role="button"
                  tabIndex={-1}
                  aria-label={`Table ${table.name}`}
                  data-node-id={table.entityId}
                  data-testid={`table-${table.name}`}
                >
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
                  <text className="crow-table__name" x={10} y={CROW_HEADER_HEIGHT / 2}>
                    {table.name}
                    {table.weak ? ' (weak)' : ''}
                  </text>

                  {table.rows.map((row, index) => {
                    const y = CROW_HEADER_HEIGHT + index * CROW_ROW_HEIGHT + CROW_ROW_HEIGHT / 2;
                    return (
                      <g key={`${row.name}-${index}`}>
                        <text className="crow-row__key" x={10} y={y}>
                          {row.pk ? 'PK' : row.fk ? 'FK' : ''}
                        </text>
                        <text
                          className={`crow-row__name${row.pk ? ' crow-row__name--pk' : ''}`}
                          x={40}
                          y={y}
                        >
                          {row.name}
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
            <p className="canvas-empty__hint">
              Switch to Chen notation to add entities and attributes
            </p>
          </div>
        </div>
      ) : null}

      <div className="canvas-status" role="status">
        <span className="canvas-status__dot canvas-status__dot--live" aria-hidden="true" />
        Crow's-foot view
        <span aria-hidden="true">·</span>
        <span>{positioned.length} {positioned.length === 1 ? 'table' : 'tables'}</span>
      </div>
    </div>
  );
}

interface End {
  x: number;
  y: number;
  h: number;
}

/**
 * Draws one relationship line between two tables, with a crow's foot at the
 * many end and a single bar at the one end. The line leaves and enters the
 * nearest horizontal edge so it never crosses a table body.
 */
function CrowConnector({ from, to, manyAtFrom }: { from: End; to: End; manyAtFrom: boolean }) {
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

  // The many end gets the fan; the one end gets a perpendicular bar.
  const manyEnd = manyAtFrom ? start : end;
  const oneEnd = manyAtFrom ? end : start;
  const manyDir = manyAtFrom ? { x: -direction.x, y: -direction.y } : direction;
  const oneDir = manyAtFrom ? direction : { x: -direction.x, y: -direction.y };

  const perpendicular = horizontal ? { x: 0, y: 1 } : { x: 1, y: 0 };

  const fan = (origin: { x: number; y: number }, dir: { x: number; y: number }) => {
    const tip = { x: origin.x + dir.x * 14, y: origin.y + dir.y * 14 };
    const spread = 9;
    const back = { x: origin.x + dir.x * 1, y: origin.y + dir.y * 1 };
    return [
      `M${origin.x} ${origin.y} L${tip.x + perpendicular.x * spread} ${tip.y + perpendicular.y * spread}`,
      `M${origin.x} ${origin.y} L${tip.x} ${tip.y}`,
      `M${origin.x} ${origin.y} L${tip.x - perpendicular.x * spread} ${tip.y - perpendicular.y * spread}`,
      // and back to the line
      `M${tip.x} ${tip.y} L${back.x} ${back.y}`,
    ].join(' ');
  };

  const bar = (origin: { x: number; y: number }, dir: { x: number; y: number }, distance: number) => {
    const c = { x: origin.x + dir.x * distance, y: origin.y + dir.y * distance };
    const half = 9;
    return `M${c.x - perpendicular.x * half} ${c.y - perpendicular.y * half} L${c.x + perpendicular.x * half} ${c.y + perpendicular.y * half}`;
  };

  return (
    <g>
      <line className="leg" x1={start.x} y1={start.y} x2={end.x} y2={end.y} />
      <path className="leg" d={fan(manyEnd, manyDir)} fill="none" />
      <path className="leg" d={bar(oneEnd, oneDir, 12)} fill="none" />
    </g>
  );
}

export { CROW_ROW_HEIGHT, CROW_HEADER_HEIGHT };
