/**
 * Auto-arrange.
 *
 * An ERD is close to bipartite: entities and relationships alternate, with
 * attributes hanging off either. That structure is what the layout exploits —
 * assign each node a layer by graph distance from the busiest node, order
 * within a layer by the average position of its neighbours (barycentre), then
 * space the layers out.
 *
 * Written by hand rather than pulling in a general graph-layout library. A
 * general engine is a megabyte of code for a problem that is bipartite and
 * small, and this version is deterministic, which means the button always
 * produces the same picture and the tests can assert exact coordinates.
 *
 * The layout only moves entities, relationships and ISAs. Attributes keep
 * their relative arrangement and follow their owner, because their position is
 * usually a deliberate choice by the person drawing.
 */

import { NODE_SIZE, type ErdDocument, type Positioned } from './types';
import { deriveTables, tableHeight } from './crowfoot';
import { ATTRIBUTE_ROW_GAP, findAttributeSlot } from './placement';

const V_GAP = 120;
const LAYER_GAP = 240;

export interface LayoutResult {
  positions: Map<string, { x: number; y: number }>;
}

interface GraphNode {
  id: string;
  neighbors: string[];
}

/** Builds an adjacency list over entities, relationships and ISAs. */
function buildGraph(doc: ErdDocument): Map<string, GraphNode> {
  const graph = new Map<string, GraphNode>();
  const add = (id: string) => {
    if (!graph.has(id)) graph.set(id, { id, neighbors: [] });
  };

  for (const e of doc.entities) add(e.id);
  for (const r of doc.relationships) add(r.id);
  for (const i of doc.isas) add(i.id);

  const link = (a: string, b: string) => {
    const na = graph.get(a);
    const nb = graph.get(b);
    if (!na || !nb) return;
    if (!na.neighbors.includes(b)) na.neighbors.push(b);
    if (!nb.neighbors.includes(a)) nb.neighbors.push(a);
  };

  for (const leg of doc.legs) link(leg.fromId, leg.toId);
  for (const isa of doc.isas) {
    if (isa.parentId) link(isa.id, isa.parentId);
    for (const child of isa.childIds) link(isa.id, child);
  }

  for (const node of graph.values()) node.neighbors.sort();
  return graph;
}

/** Breadth-first layer assignment from a chosen root. */
function assignLayers(graph: Map<string, GraphNode>, root: string): Map<string, number> {
  const layers = new Map<string, number>();
  const queue: string[] = [root];
  layers.set(root, 0);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const depth = layers.get(current)!;
    const node = graph.get(current);
    if (!node) continue;
    for (const next of node.neighbors) {
      if (layers.has(next)) continue;
      layers.set(next, depth + 1);
      queue.push(next);
    }
  }

  // Any node not reached (disconnected components) starts a fresh chain.
  for (const id of graph.keys()) {
    if (!layers.has(id)) {
      layers.set(id, 0);
      const queue2: string[] = [id];
      while (queue2.length > 0) {
        const current = queue2.shift()!;
        const depth = layers.get(current)!;
        const node = graph.get(current);
        if (!node) continue;
        for (const next of node.neighbors) {
          if (layers.has(next)) continue;
          layers.set(next, depth + 1);
          queue2.push(next);
        }
      }
    }
  }
  return layers;
}

/**
 * Orders nodes within each layer by barycentre over already-placed earlier
 * layers. Two sweeps (down then up) is enough for diagrams of this size and
 * keeps the result stable.
 */
function orderLayers(
  graph: Map<string, GraphNode>,
  layers: Map<string, number>,
  layerCount: number,
): string[][] {
  const buckets: string[][] = Array.from({ length: layerCount }, () => []);
  for (const [id, layer] of layers) buckets[layer]!.push(id);
  for (const bucket of buckets) bucket.sort();

  const indexIn = (id: string): number => {
    const layer = layers.get(id);
    if (layer === undefined) return 0;
    return buckets[layer]!.indexOf(id);
  };

  for (let sweep = 0; sweep < 2; sweep += 1) {
    const forward = sweep % 2 === 0;
    const order = forward
      ? Array.from({ length: layerCount }, (_, i) => i)
      : Array.from({ length: layerCount }, (_, i) => layerCount - 1 - i);

    for (const layerIndex of order) {
      const bucket = buckets[layerIndex]!;
      const scored = bucket.map((id) => {
        const node = graph.get(id)!;
        const placed = node.neighbors.filter((n) => {
          const nl = layers.get(n);
          return forward ? nl !== undefined && nl < layerIndex : nl !== undefined && nl > layerIndex;
        });
        const score =
          placed.length === 0
            ? indexIn(id)
            : placed.reduce((sum, n) => sum + indexIn(n), 0) / placed.length;
        return { id, score };
      });
      scored.sort((a, b) => (a.score === b.score ? (a.id < b.id ? -1 : 1) : a.score - b.score));
      buckets[layerIndex] = scored.map((s) => s.id);
    }
  }
  return buckets;
}

/**
 * Arranges every graph node. Returns absolute top-left positions, centred so
 * the diagram lands around the origin.
 */
export function autoArrange(doc: ErdDocument): LayoutResult {
  const tableSizes = new Map(
    (doc.view === 'crowfoot' ? deriveTables(doc) : []).map((table) =>
      [table.entityId, { w: table.width, h: tableHeight(table) }] as const),
  );
  const renderedSize = (id: string) => tableSizes.get(id) ?? sizeFor(doc, id);
  const graph = buildGraph(doc);
  const positions = new Map<string, { x: number; y: number }>();
  if (graph.size === 0) return { positions };

  // Root at an entity, so the diagram reads entity → relationship → entity
  // rather than starting on a diamond. Among entities, prefer one that is an
  // ISA parent (so a hierarchy reads top-down), then the highest degree, then
  // the lowest id for determinism.
  const isIsaParent = new Set(
    doc.isas.map((i) => i.parentId).filter((id): id is string => typeof id === 'string'),
  );
  let root = '';
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const node of graph.values()) {
    const isEntity = doc.entities.some((e) => e.id === node.id);
    if (!isEntity) continue;
    const score = (isIsaParent.has(node.id) ? 1000 : 0) + node.neighbors.length;
    if (score > bestScore || (score === bestScore && node.id < root)) {
      bestScore = score;
      root = node.id;
    }
  }
  // Fall back to any node when the document has no entities.
  if (root === '') {
    let bestDegree = -1;
    for (const node of graph.values()) {
      const degree = node.neighbors.length;
      if (degree > bestDegree || (degree === bestDegree && node.id < root)) {
        bestDegree = degree;
        root = node.id;
      }
    }
  }

  const layers = assignLayers(graph, root);
  const layerCount = Math.max(...layers.values()) + 1;
  const buckets = orderLayers(graph, layers, layerCount);

  // Column widths from the widest node in each layer keeps shapes from colliding.
  const columnWidth = (bucket: string[]): number =>
    bucket.reduce((max, id) => {
      const size = renderedSize(id);
      return Math.max(max, size.w);
    }, 0);

  const columnWidths = buckets.map(columnWidth);
  const columnCenters: number[] = [];
  let cursor = 0;
  for (let i = 0; i < layerCount; i += 1) {
    const width = columnWidths[i] ?? 0;
    columnCenters.push(cursor + width / 2);
    cursor += width + LAYER_GAP;
  }

  for (let layerIndex = 0; layerIndex < layerCount; layerIndex += 1) {
    const bucket = buckets[layerIndex]!;
    let y = 0;
    for (const id of bucket) {
      const size = renderedSize(id);
      positions.set(id, { x: columnCenters[layerIndex]! - size.w / 2, y });
      /*
       * Reserve room for the attributes hanging off this shape.
       *
       * Attributes are placed in a column beside their owner, so two shapes
       * stacked in the same column can collide through their attributes even
       * though the shapes themselves do not touch. Counting the block here is
       * what makes "no overlap" true of the drawing rather than only of the
       * nodes. Crow's-foot tables are exempt: a table already contains its
       * attributes as rows, so `renderedSize` has counted them.
       */
      y += size.h + attributeBlock(doc, id) + V_GAP;
    }
  }

  return { positions };
}

/** Vertical space the attributes owned by `id` occupy beside it, in Chen. */
function attributeBlock(doc: ErdDocument, id: string): number {
  if (doc.view === 'crowfoot') return 0;
  const owned = doc.attributes.filter((attribute) => attribute.ownerId === id).length;
  if (owned === 0) return 0;
  // One gap between the owner and the first attribute, then one between each.
  return owned * NODE_SIZE.attribute.h + owned * ATTRIBUTE_ROW_GAP;
}

function sizeFor(doc: ErdDocument, id: string): { w: number; h: number } {
  if (doc.entities.some((e) => e.id === id)) return NODE_SIZE.entity;
  if (doc.attributes.some((a) => a.id === id)) return NODE_SIZE.attribute;
  if (doc.relationships.some((r) => r.id === id)) return NODE_SIZE.relationship;
  if (doc.isas.some((i) => i.id === id)) return NODE_SIZE.isa;
  return { w: 0, h: 0 };
}

/**
 * Applies a layout to a document, returning a new document with every node
 * moved. Attributes follow their owner by their original offset, which
 * preserves whatever arrangement the person chose for them.
 */
export function applyLayout(doc: ErdDocument): ErdDocument {
  const { positions } = autoArrange(doc);
  if (positions.size === 0) return doc;

  const move = <T extends Positioned>(node: T): T => {
    const next = positions.get(node.id);
    return next ? { ...node, x: next.x, y: next.y } : node;
  };

  const movedEntities = doc.entities.map(move);
  const movedRelationships = doc.relationships.map(move);
  const movedIsas = doc.isas.map(move);

  const entityDelta = new Map<string, { dx: number; dy: number }>();
  for (const before of [...doc.entities, ...doc.relationships, ...doc.isas]) {
    const after = [...movedEntities, ...movedRelationships, ...movedIsas].find((e) => e.id === before.id);
    if (after) entityDelta.set(before.id, { dx: after.x - before.x, dy: after.y - before.y });
  }

  /*
   * Attributes move with their owner, and then get placed.
   *
   * Keeping the old offset alone looked respectful and was wrong: an offset
   * chosen when the entity was somewhere else lands the attribute on top of its
   * owner, or on top of a sibling attribute, once the owner has been rearranged
   * into a column. Measured on a three-table schema, that was 30 overlapping
   * pairs. So the shift is still the owner's delta — the arrangement the person
   * chose is preserved as a *group* — and then each attribute is placed beside
   * its owner by the same routine that positions a new one, in the same order.
   */
  const movedEntitiesById = new Map(movedEntities.map((e) => [e.id, e]));
  const movedRelationshipsById = new Map(movedRelationships.map((r) => [r.id, r]));
  const movedIsasById = new Map(movedIsas.map((i) => [i.id, i]));
  const ownerAt = (ownerId: string): ErdDocument['entities'][number] | ErdDocument['relationships'][number] | ErdDocument['isas'][number] | undefined =>
    movedEntitiesById.get(ownerId) ?? movedRelationshipsById.get(ownerId) ?? movedIsasById.get(ownerId);

  const movedAttributes: ErdDocument['attributes'] = [];
  let placed: ErdDocument = { ...doc, entities: movedEntities, relationships: movedRelationships, isas: movedIsas };
  for (const attr of doc.attributes) {
    const delta = attr.ownerId ? entityDelta.get(attr.ownerId) : undefined;
    const shifted = delta && attr.ownerId
      ? { ...attr, x: attr.x + delta.dx, y: attr.y + delta.dy }
      : attr;
    const owner = attr.ownerId ? ownerAt(attr.ownerId) : undefined;
    if (!owner) {
      movedAttributes.push(shifted);
      continue;
    }
    // Place against what has been arranged so far, so siblings stack rather
    // than each claiming the same slot.
    const slot = findAttributeSlot({ ...placed, attributes: movedAttributes }, owner.id);
    const next = slot ? { ...shifted, x: slot.x, y: slot.y } : shifted;
    movedAttributes.push(next);
    placed = { ...placed, attributes: movedAttributes };
  }

  return {
    ...doc,
    entities: movedEntities,
    relationships: movedRelationships,
    isas: movedIsas,
    attributes: movedAttributes,
  };
}
