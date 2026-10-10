import { describe, expect, it } from 'vitest';
import {
  allNodes,
  attributesOf,
  emptyDocument,
  findNode,
  isValidLeg,
  legsFor,
  nodeKind,
  NODE_SIZE,
  removeNode,
  sizeOf,
  type ErdDocument,
} from '../../src/model/types';

function docWithNodes(): ErdDocument {
  const doc = emptyDocument('Test');
  doc.entities.push(
    { id: 'e1', name: 'Customer', x: 0, y: 0, kind: 'strong' },
    { id: 'e2', name: 'Order', x: 300, y: 0, kind: 'strong' },
  );
  doc.relationships.push({ id: 'r1', name: 'places', x: 150, y: 0, kind: 'strong' });
  doc.attributes.push(
    { id: 'a1', name: 'customer_id', x: -100, y: 0, kind: 'key', ownerId: 'e1' },
    { id: 'a2', name: 'email', x: -100, y: 60, kind: 'simple', ownerId: 'e1' },
    { id: 'a3', name: 'order_id', x: 400, y: 0, kind: 'key', ownerId: 'e2' },
  );
  doc.isas.push({ id: 'i1', x: 600, y: 0, parentId: 'e1', childIds: [] });
  doc.legs.push(
    { id: 'l1', fromId: 'e1', toId: 'r1', cardinality: '1', participation: { min: 0, max: 1 } },
    { id: 'l2', fromId: 'r1', toId: 'e2', cardinality: 'N', participation: { min: 1, max: 'N' } },
  );
  return doc;
}

describe('document model', () => {
  it('starts empty with a chen view', () => {
    const doc = emptyDocument();
    expect(doc.view).toBe('chen');
    expect(allNodes(doc)).toHaveLength(0);
  });

  it('lists every positioned node across all collections', () => {
    const doc = docWithNodes();
    expect(allNodes(doc).map((n) => n.id).sort()).toEqual(['a1', 'a2', 'a3', 'e1', 'e2', 'i1', 'r1']);
  });

  it('reports the kind of each node', () => {
    const doc = docWithNodes();
    expect(nodeKind(doc, 'e1')).toBe('entity');
    expect(nodeKind(doc, 'a1')).toBe('attribute');
    expect(nodeKind(doc, 'r1')).toBe('relationship');
    expect(nodeKind(doc, 'i1')).toBe('isa');
    expect(nodeKind(doc, 'nope')).toBeUndefined();
  });

  it('returns nominal sizes that match the node kind', () => {
    const doc = docWithNodes();
    expect(sizeOf(doc, 'e1')).toEqual(NODE_SIZE.entity);
    expect(sizeOf(doc, 'a1')).toEqual(NODE_SIZE.attribute);
    expect(sizeOf(doc, 'missing')).toEqual({ w: 0, h: 0 });
  });

  it('finds a node by id', () => {
    const doc = docWithNodes();
    expect(doc.entities.find((e) => e.id === 'e2')?.name).toBe('Order');
    expect(findNode(doc, 'ghost')).toBeUndefined();
  });

  it('rejects legs that loop or point at missing nodes', () => {
    const doc = docWithNodes();
    expect(isValidLeg(doc, { id: 'x', fromId: 'e1', toId: 'e2', cardinality: '1', participation: { min: 0, max: 1 } })).toBe(true);
    expect(isValidLeg(doc, { id: 'x', fromId: 'e1', toId: 'e1', cardinality: '1', participation: { min: 0, max: 1 } })).toBe(false);
    expect(isValidLeg(doc, { id: 'x', fromId: 'e1', toId: 'nope', cardinality: '1', participation: { min: 0, max: 1 } })).toBe(false);
  });

  it('finds legs attached to a node in either direction', () => {
    const doc = docWithNodes();
    expect(legsFor(doc, 'e1').map((l) => l.id)).toEqual(['l1']);
    expect(legsFor(doc, 'r1').map((l) => l.id)).toEqual(['l1', 'l2']);
    expect(legsFor(doc, 'e2').map((l) => l.id)).toEqual(['l2']);
  });

  it('finds attributes by owner', () => {
    const doc = docWithNodes();
    expect(attributesOf(doc, 'e1').map((a) => a.name)).toEqual(['customer_id', 'email']);
    expect(attributesOf(doc, 'e2')).toHaveLength(1);
  });
});

describe('removeNode', () => {
  it('removes the node, its legs, its attributes, and its isa links', () => {
    const doc = docWithNodes();
    const next = removeNode(doc, 'e1');
    expect(next.entities.map((e) => e.id)).toEqual(['e2']);
    expect(next.attributes.map((a) => a.id)).toEqual(['a3']);
    expect(next.legs.map((l) => l.id)).toEqual(['l2']);
    expect(next.isas.find((i) => i.id === 'i1')?.parentId).toBeNull();
  });

  it('does not mutate the original document', () => {
    const doc = docWithNodes();
    const before = JSON.stringify(doc);
    removeNode(doc, 'e1');
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('removes a relationship and its legs', () => {
    const doc = docWithNodes();
    const next = removeNode(doc, 'r1');
    expect(next.relationships).toHaveLength(0);
    expect(next.legs).toHaveLength(0);
  });

  it('strips removed entities from isa child lists', () => {
    const doc = docWithNodes();
    doc.isas[0]!.childIds = ['e2', 'e1'];
    const next = removeNode(doc, 'e2');
    expect(next.isas[0]!.childIds).toEqual(['e1']);
  });
});
