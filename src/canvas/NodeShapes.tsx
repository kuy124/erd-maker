/**
 * Shape rendering for the Chen view.
 *
 * Each ERD primitive is a small component so the notation stays legible in
 * code: a rectangle is an entity, an ellipse an attribute, a rhombus a
 * relationship, a triangle an ISA. The double outlines that mark weak entities
 * and weak relationships are drawn as a second inset shape rather than a
 * thicker stroke, which is the actual convention.
 *
 * Long labels use two lines within the fixed shape. Full names remain in
 * accessible labels, titles, the outline, and properties.
 */

import { memo } from 'react';
import { NODE_SIZE, type Attribute, type Entity, type Isa, type Relationship } from '../model/types';
import type { PeerState } from '../collab/provider';
import { groupFrame, type ErdDocument, type Group } from '../model/types';
import type { Point } from './geometry';

interface BaseProps {
  selected: boolean;
  onPointerDown: (event: React.PointerEvent) => void;
  peerColor?: string | undefined;
  /** True while a relationship line is being drawn from this shape. */
  connecting?: boolean | undefined;
  /** True when the pointer is over this shape as a legal connection target. */
  connectable?: boolean | undefined;
}

/**
 * Extra class for the connection gesture.
 *
 * Kept in one place so every primitive lights up the same way; a legend that
 * highlights some shapes and not others teaches the wrong thing.
 */
function connectClass(props: Pick<BaseProps, 'connecting' | 'connectable'>): string {
  if (props.connecting) return ' node--connecting';
  if (props.connectable) return ' node--connectable';
  return '';
}

function Outline({ selected, peerColor, x, y, w, h }: { selected: boolean; peerColor?: string | undefined; x: number; y: number; w: number; h: number }) {
  if (!selected && !peerColor) return null;
  return (
    <rect
      className="selection-ring"
      x={x - 5}
      y={y - 5}
      width={w + 10}
      height={h + 10}
      style={peerColor ? { stroke: peerColor, strokeDasharray: '5 3' } : undefined}
    />
  );
}

export const EntityShape = memo(function EntityShape({
  entity,
  selected,
  onPointerDown,
  peerColor,
  connecting,
  connectable,
}: BaseProps & { entity: Entity }) {
  const { w, h } = NODE_SIZE.entity;
  const weak = entity.kind === 'weak';
  return (
    <g
      className={`node${weak ? ' node--weak' : ''}${connectClass({ connecting, connectable })}`}
      transform={`translate(${entity.x} ${entity.y})`}
      onPointerDown={onPointerDown}
      role="button"
      tabIndex={-1}
      aria-label={`Entity ${entity.name}${weak ? ', weak' : entity.kind === 'associative' ? ', associative' : ''}`}
      data-node-id={entity.id}
    >
      <rect className="node__body" width={w} height={h} />
      {weak ? <rect className="node__body" x={5} y={5} width={w - 10} height={h - 10} /> : null}
      {entity.kind === 'associative' ? <polygon className="node__body entity-associative"
        points={`${w / 2},5 ${w - 5},${h / 2} ${w / 2},${h - 5} 5,${h / 2}`} /> : null}
      <ShapeLabel name={entity.name} x={w / 2} y={h / 2} limit={20} />
      <Outline selected={selected} peerColor={peerColor} x={0} y={0} w={w} h={h} />
    </g>
  );
});

export const RelationshipShape = memo(function RelationshipShape({
  relationship,
  selected,
  onPointerDown,
  peerColor,
  connecting,
  connectable,
}: BaseProps & { relationship: Relationship }) {
  const { w, h } = NODE_SIZE.relationship;
  const hw = w / 2;
  const hh = h / 2;
  const weak = relationship.kind === 'weak';
  const points = `${hw},0 ${w},${hh} ${hw},${h} 0,${hh}`;
  return (
    <g
      className={`node${weak ? ' node--weak' : ''}${connectClass({ connecting, connectable })}`}
      transform={`translate(${relationship.x} ${relationship.y})`}
      onPointerDown={onPointerDown}
      role="button"
      tabIndex={-1}
      aria-label={`Relationship ${relationship.name}${weak ? ', identifying' : ''}`}
      data-node-id={relationship.id}
    >
      <polygon className="node__body" points={points} />
      {weak ? (
        <polygon
          className="node__body"
          points={`${hw},6 ${w - 8},${hh} ${hw},${h - 6} 8,${hh}`}
        />
      ) : null}
      <ShapeLabel name={relationship.name} x={hw} y={hh} limit={13} />
      <Outline selected={selected} peerColor={peerColor} x={0} y={0} w={w} h={h} />
    </g>
  );
});

export const AttributeShape = memo(function AttributeShape({
  attribute,
  selected,
  onPointerDown,
  peerColor,
  connecting,
  connectable,
}: BaseProps & { attribute: Attribute }) {
  const { w, h } = NODE_SIZE.attribute;
  const rx = w / 2;
  const ry = h / 2;
  const key = attribute.kind === 'key';
  const unique = attribute.kind === 'unique';
  const multivalued = attribute.kind === 'multivalued';
  const derived = attribute.kind === 'derived';

  return (
    <g
      className={`node${connectClass({ connecting, connectable })}`}
      transform={`translate(${attribute.x} ${attribute.y})`}
      onPointerDown={onPointerDown}
      role="button"
      tabIndex={-1}
      aria-label={`Attribute ${attribute.name}, ${attribute.kind}`}
      data-node-id={attribute.id}
    >
      <ellipse className="node__body" cx={rx} cy={ry} rx={rx} ry={ry} />
      {multivalued ? (
        <ellipse className="node__body" cx={rx} cy={ry} rx={rx - 5} ry={ry - 5} />
      ) : null}
      {derived ? (
        <ellipse
          className="node__body"
          cx={rx}
          cy={ry}
          rx={rx}
          ry={ry}
          style={{ strokeDasharray: '5 4' }}
        />
      ) : null}
      <ShapeLabel name={attribute.name} x={rx} y={ry - ((key || unique) && attribute.name.length <= 16 ? 4 : 0)} limit={16}
        underline={key && attribute.name.length > 16} />
      {/* Key attributes are underlined, the standard Chen convention. */}
      {key && attribute.name.length <= 16 ? (
        <line
          className="node__key-line"
          x1={rx - Math.min(measureLabel(attribute.name) / 2, rx - 10)}
          y1={ry + 8}
          x2={rx + Math.min(measureLabel(attribute.name) / 2, rx - 10)}
          y2={ry + 8}
        />
      ) : null}
      {/*
        A unique column is underlined with a broken line: it identifies a row
        on its own, but it is not the primary key, and the two should not be
        mistaken for one another.
      */}
      {unique ? (
        <line
          className="node__key-line"
          x1={rx - Math.min(measureLabel(attribute.name) / 2, rx - 10)}
          y1={ry + 8}
          x2={rx + Math.min(measureLabel(attribute.name) / 2, rx - 10)}
          y2={ry + 8}
          strokeDasharray="3 3"
        />
      ) : null}
      <Outline selected={selected} peerColor={peerColor} x={0} y={0} w={w} h={h} />
    </g>
  );
});

/**
 * Rough text width for the key underline. A real measurement would need the font
 * loaded; 6.6px per character is close for 13px IBM Plex Sans and errs slightly
 * wide, which looks intentional rather than clipped.
 *
 * The floor is deliberately tiny. It used to be 18px, which is wider than the
 * word "id" is drawn — so a short key got a long bar hanging off it, while a long
 * key looked right because the per-character estimate dominated. The floor only
 * exists so a one-character name still gets a visible line.
 */
function measureLabel(text: string): number {
  return Math.max(7, text.length * 6.6);
}

function ShapeLabel({ name, x, y, limit, underline = false }: {
  name: string; x: number; y: number; limit: number; underline?: boolean;
}) {
  const chars = Array.from(name);
  const prefix = chars.slice(0, limit).join('');
  const breakAt = Math.max(prefix.lastIndexOf(' '), prefix.lastIndexOf('_'));
  const split = breakAt >= limit / 2 ? breakAt + 1 : limit;
  const remaining = chars.slice(split).join('').trimStart();
  const lines = chars.length <= limit ? [name] : [chars.slice(0, split).join('').trimEnd(),
    remaining.length > limit ? remaining.slice(0, limit - 1) + '…' : remaining];
  return <text className="node__label" x={x} y={y} style={underline ? { textDecoration: 'underline' } : undefined}>
    <title>{name + ' — full shape name'}</title>
    {lines.map((line, index) => <tspan key={index} x={x} y={y + (index - (lines.length - 1) / 2) * 16}>{line}</tspan>)}
  </text>;
}

export const IsaShape = memo(function IsaShape({
  isa,
  selected,
  onPointerDown,
  peerColor,
  connecting,
  connectable,
}: BaseProps & { isa: Isa }) {
  const { w, h } = NODE_SIZE.isa;
  const hw = w / 2;
  const hh = h / 2;
  // A downward triangle with the ISA label inside, apex at the top.
  const points = `0,${h} ${w},${h} ${hw},0`;
  return (
    <g
      className={`node${connectClass({ connecting, connectable })}`}
      transform={`translate(${isa.x} ${isa.y})`}
      onPointerDown={onPointerDown}
      role="button"
      tabIndex={-1}
      aria-label="Specialization"
      data-node-id={isa.id}
    >
      <polygon className="isa-triangle" points={points} />
      <text className="isa-label" x={hw} y={hh + 6}>
        ISA
      </text>
      <Outline selected={selected} peerColor={peerColor} x={0} y={0} w={w} h={h} />
    </g>
  );
});

/** ERDPlus-style endpoint symbols, also used by the table renderer. */
export function CardinalityMarker({ origin, toward, many, required, className = 'leg', scale = 1 }: {
  origin: Point; toward: Point; many: boolean; required: boolean; className?: string; scale?: number;
}) {
  const angle = Math.atan2(toward.y - origin.y, toward.x - origin.x) * 180 / Math.PI;
  return <g transform={`translate(${origin.x} ${origin.y}) rotate(${angle})${scale === 1 ? '' : ` scale(${scale})`}`} pointerEvents="none">
    <path className={className} data-cardinality={many ? 'many' : 'one'}
      d={many ? 'M14 0 L1 9 M14 0 L1 -9' : 'M10 -9 L10 9'} />
    {required ? <path className={className} data-participation="required" d="M22 -9 L22 9" /> :
      <circle className={className} data-participation="optional" cx={22} cy={0} r={4}
        style={{ fill: 'var(--paper)' }} />}
  </g>;
}

/**
 * Where everyone else is pointing.
 *
 * Lives in the viewport group so cursors sit in world coordinates and move with
 * the diagram under each reader's own pan and zoom — the same convention the
 * selection rings use. Shared by both notations because a peer is a peer.
 *
 * The name always travels with the colour: colour alone is not something
 * everyone can tell apart, and an unnamed arrow says nothing.
 */
/**
 * Other people's cursors, but only those reading the same drawing.
 *
 * Chen and Crow's-foot place one schema at different coordinates, so a cursor
 * from somebody in the other notation points at a shape that is not there. It is
 * filtered out rather than drawn in the wrong place: an arrow that lies about
 * where somebody is pointing is worse than no arrow.
 */
export function PeerCursors({ peers, view, onFollow }: { peers: PeerState[]; view: 'chen' | 'crowfoot'; onFollow?: (id: number) => void }) {
  const visible = peers.filter((peer) => peer.view === view && peer.cursor);
  // Keep stacked peer names from covering each other by nudging chips.
  const names = visible.map((peer) => {
    const cluster = visible.filter((other) => other.clientId !== peer.clientId &&
      !!other.cursor && Math.hypot(other.cursor!.x! - peer.cursor!.x!, other.cursor!.y! - peer.cursor!.y!) < 48).length;
    const index = visible.indexOf(peer);
    return { peer, offset: cluster ? index * 14 : 0 };
  });

  return (
    <g className="layer-peers">
      {names.map(({ peer, offset }) =>
        peer.cursor ? (
          <g key={peer.clientId}
            className={`peer-cursor${peer.dragging ? ' peer-cursor--carrying' : ''}${peer.pressing ? ' peer-cursor--pressed' : ''}${peer.typing ? ' peer-cursor--typing' : ''}`}
            data-peer-id={peer.clientId}
            style={{ cursor: onFollow ? 'pointer' : undefined }}
            onClick={() => onFollow?.(peer.clientId)}
            transform={`translate(${peer.cursor.x} ${peer.cursor.y})`}>
            <g transform={`translate(${offset} 0)`}>
              <circle className="peer-cursor__ring" cx="0" cy="0" r="8" fill="none" stroke={peer.color} strokeWidth="1.5" />
              <path d="M0 0 L0 15 L4 11 L7 17 L10 15.5 L7 10 L12 10 Z" fill={peer.color} stroke="var(--paper)" strokeWidth="1" />
              <rect className="peer-cursor__chip" x="14" y="12" width={peer.name.length * 6.4 + 10} height="17" fill={peer.color} />
              <text className="peer-cursor__name" x="19" y="24">
                {peer.name}
              </text>
              {peer.typing ? (
                <g className="peer-cursor__typing" transform={`translate(${peer.name.length * 6.4 + 30} 20)`}>
                  <circle r="2" cx="0" cy="0" className="dots d1" />
                  <circle r="2" cx="5" cy="0" className="dots d2" />
                  <circle r="2" cx="10" cy="0" className="dots d3" />
                </g>
              ) : null}

            </g>
          </g>
        ) : null,
      )}
    </g>
  );
}

/**
 * The frame around a group.
 *
 * Drawn from the members' bounds rather than stored, so it cannot drift away
 * from what it contains. Purely a working aid: it never reaches an export, and
 * the SQL generator never sees it.
 */
export function GroupFrames({ doc }: { doc: ErdDocument }) {
  return (
    <g className="layer-groups">
      {doc.groups.map((group: Group) => {
        const frame = groupFrame(doc, group);
        if (!frame) return null;
        return (
          <g key={group.id} className="group-frame" data-group-id={group.id}>
            <rect
              x={frame.minX} y={frame.minY}
              width={frame.maxX - frame.minX} height={frame.maxY - frame.minY}
              rx={10}
            />
            <text className="group-frame__name" x={frame.minX + 10} y={frame.minY + 15}>
              {group.name}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/** Small preview glyphs for the tool rail. Drawn, not iconic. */
export function ShapeGlyph({ kind, size = 20 }: { kind: 'entity' | 'attribute' | 'relationship' | 'isa'; size?: number }) {
  const stroke = 'currentColor';
  if (kind === 'entity') {
    return (
      <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <rect x="2" y="5" width="16" height="10" fill="none" stroke={stroke} strokeWidth="1.5" />
      </svg>
    );
  }
  if (kind === 'attribute') {
    return (
      <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <ellipse cx="10" cy="10" rx="8" ry="5.5" fill="none" stroke={stroke} strokeWidth="1.5" />
      </svg>
    );
  }
  if (kind === 'relationship') {
    return (
      <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <polygon points="10,2 18,10 10,18 2,10" fill="none" stroke={stroke} strokeWidth="1.5" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <polygon points="2,16 18,16 10,3" fill="none" stroke={stroke} strokeWidth="1.5" />
    </svg>
  );
}
