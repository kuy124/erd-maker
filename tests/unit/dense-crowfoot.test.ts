import { expect, it } from 'vitest';
import { applyLayout } from '../../src/model/layout';
import { deriveLinks, deriveTables, routeColumns, routeLinks, tableHeight, tableObstacle, type CrowTable } from '../../src/model/crowfoot';
import { emptyDocument } from '../../src/model/types';
import { isRouteSafe, type RoutePoint } from '../../src/model/connectorRouting';

function schema(count: number, shape: 'star' | 'mesh' | 'isolated') {
  const doc = emptyDocument('Crowded schema');
  doc.view = 'crowfoot';
  for (let i = 0; i < count; i++) {
    const id = `e${String(i).padStart(2, '0')}`;
    doc.entities.push({ id, name: `Table_${i}`, kind: 'strong', x: 0, y: 0 });
    for (let a = 0; a < 6; a++) doc.attributes.push({ id: `${id}-${a}`, name: a ? `field_${a}` : 'id',
      kind: a ? 'simple' : 'key', ownerId: id, x: 0, y: 0 });
  }
  for (let i = 1; i < count; i++) {
    const targets = shape === 'isolated' ? [] : shape === 'star' ? [0] : [i - 1, Math.max(0, i - 3)];
    for (const target of new Set(targets)) {
      const id = `r${i}-${target}`;
      doc.relationships.push({ id, name: `link_${i}_${target}`, kind: 'strong', x: 0, y: 0 });
      doc.legs.push({ id: `${id}-a`, fromId: doc.entities[target]!.id, toId: id, cardinality: '1', participation: { min: 0, max: 1 } },
        { id: `${id}-b`, fromId: id, toId: doc.entities[i]!.id, cardinality: 'N', participation: { min: 0, max: 'N' } });
    }
  }
  return doc;
}

function overlap(paths: RoutePoint[][]) {
  let length = 0;
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
    const first = paths[i]!, second = paths[j]!;
    for (let a = 1; a < first.length; a++) for (let b = 1; b < second.length; b++) {
      const p = first[a - 1]!, q = first[a]!, r = second[b - 1]!, s = second[b]!;
      const axis = p.x === q.x ? 'y' : 'x', fixed = axis === 'x' ? 'y' : 'x';
      if (r[fixed] !== s[fixed] || p[fixed] !== r[fixed]) continue;
      const shared = Math.min(Math.max(p[axis], q[axis]), Math.max(r[axis], s[axis])) -
        Math.max(Math.min(p[axis], q[axis]), Math.min(r[axis], s[axis]));
      const commonPort = axis === 'x' && [first[0]!, first.at(-1)!].some(port =>
        [second[0]!, second.at(-1)!].some(other => port.x === other.x && port.y === other.y) &&
        port.y === p.y && port.x >= Math.min(p.x, q.x) && port.x <= Math.max(p.x, q.x) &&
        port.x >= Math.min(r.x, s.x) && port.x <= Math.max(r.x, s.x));
      length += Math.max(0, shared - (commonPort ? 36 : 0));
    }
  }
  return length;
}

it('uses the actual facing widths instead of detouring around a wide target', () => {
  const table = (x: number, width: number): CrowTable => ({ entityId: String(x), name: 'Table', x, y: x ? 120 : 0,
    width, weak: false, rows: [{ id: 'id', name: 'id', attributeId: null, type: 'INTEGER', pk: true, fk: false }] });
  const route = routeColumns(table(0, 280), 'id', table(600, 900), 'id');
  expect(route.b.x).toBe(600);
  expect(route.bounds.maxX).toBeLessThanOrEqual(600);
});

it.each([['star', 24], ['mesh', 48], ['isolated', 30]] as const)('keeps %s layouts with %i tables compact and safely routed', (shape, count) => {
  const doc = applyLayout(schema(count, shape));
  const tables = deriveTables(doc), links = deriveLinks(doc);
  const boxes = tables.map(tableObstacle);
  const width = Math.max(...boxes.map(b => b.maxX)) - Math.min(...boxes.map(b => b.minX));
  const height = Math.max(...boxes.map(b => b.maxY)) - Math.min(...boxes.map(b => b.minY));
  expect(Math.max(width / height, height / width)).toBeLessThan(2.5);
  for (let i = 0; i < tables.length; i++) for (let j = i + 1; j < tables.length; j++) {
    const a = tables[i]!, b = tables[j]!;
    expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + tableHeight(a) <= b.y || b.y + tableHeight(b) <= a.y).toBe(true);
  }
  const independent = links.map(link => {
    const a = tables.find(t => t.entityId === link.fromEntityId)!, b = tables.find(t => t.entityId === link.toEntityId)!;
    return routeColumns(a, link.fromColumnId, b, link.toColumnId, link.lane, boxes);
  });
  const routes = [...routeLinks(tables, links).values()];
  for (const route of routes) expect(isRouteSafe(route.points, route.guard)).toBe(true);
  const before = overlap(independent.map(route => route.points)), after = overlap(routes.map(route => route.points));
  if (before) expect(after).toBeLessThan(before * 0.65);
  if (links.length) {
    const edited = { ...links[0]!, routePoints: independent[0]!.points };
    const preserved = routeLinks(tables, [edited, ...links.slice(1)]).get(edited.id)!;
    expect(preserved.manualAccepted).toBe(true);
    expect(preserved.points).toEqual(edited.routePoints);
  }
  expect(applyLayout(doc)).toEqual(doc);
});
