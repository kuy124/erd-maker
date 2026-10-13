import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { emptyDocument, removeNode } from '../../src/model/types';
import { deriveTables } from '../../src/model/crowfoot';
import { generateSql, describeSqlReadiness } from '../../src/model/sql';
import { normalizeDocument, encodeSnapshot, decodeSnapshot } from '../../src/model/snapshot';
import { deleteNodeFromYdoc, snapshotFromYdoc, seedDocument } from '../../src/collab/ydoc';
import { applyLayout } from '../../src/model/layout';
import { findAttributeSlot } from '../../src/model/placement';

function schema() {
  const doc = emptyDocument();
  doc.entities = [{ id: 'e', name: 'Customer', x: 0, y: 0, kind: 'strong' }];
  // Children deliberately precede their parents, as they can in Yjs snapshots.
  doc.attributes = [
    { id: 'leaf', name: 'Street', x: 0, y: 0, kind: 'key', ownerId: 'address', dataType: 'VARCHAR(64)' },
    { id: 'address', name: 'Address', x: 0, y: 0, kind: 'composite', ownerId: 'billing' },
    { id: 'billing', name: 'Billing', x: 0, y: 0, kind: 'composite', ownerId: 'e' },
  ] as typeof doc.attributes;
  return doc;
}

describe('composite attributes', () => {
  it('projects nested leaves with their identity, key and chosen type into tables and SQL', () => {
    const doc = schema();
    expect(deriveTables(doc)[0]!.rows).toMatchObject([
      { id: 'attribute:leaf', attributeId: 'leaf', name: 'billing_address_street', pk: true, type: 'VARCHAR(64)' },
    ]);
    const sql = generateSql(doc);
    expect(sql).toContain('"billing_address_street" VARCHAR(64)');
    expect(sql).toContain('PRIMARY KEY ("billing_address_street")');
    expect(sql).not.toContain('"billing" TEXT');
    expect(describeSqlReadiness(doc)).toBe('Ready.');
  });

  it('preserves nested ownership through JSON, snapshot links and shared state', () => {
    const doc = schema();
    const ydoc = new Y.Doc();
    seedDocument(ydoc, doc);
    for (const result of [normalizeDocument(doc), decodeSnapshot(encodeSnapshot(doc)), snapshotFromYdoc(ydoc)]) {
      expect(result!.attributes.find(a => a.id === 'leaf')?.ownerId).toBe('address');
      expect(result!.attributes.find(a => a.id === 'address')?.ownerId).toBe('billing');
    }
    ydoc.destroy();
  });

  it('deletes the entire subtree, including descendants in groups', () => {
    const doc = schema();
    doc.groups = [{ id: 'g', name: 'Parts', memberIds: ['leaf', 'address', 'e'] }];
    expect(removeNode(doc, 'billing').attributes).toEqual([]);
    const ydoc = new Y.Doc();
    seedDocument(ydoc, doc);
    deleteNodeFromYdoc(ydoc, 'billing');
    expect(snapshotFromYdoc(ydoc).attributes).toEqual([]);
    expect(snapshotFromYdoc(ydoc).groups).toEqual([]);
    ydoc.destroy();
  });

  it('places and arranges a nested tree independently of attribute ordering', () => {
    const doc = schema();
    expect(findAttributeSlot(doc, 'address')).not.toBeNull();
    const arranged = applyLayout(doc);
    const boxes = [...arranged.entities, ...arranged.attributes].map(n => ({ ...n,
      w: n.id === 'e' ? 150 : 130, h: n.id === 'e' ? 60 : 52 }));
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!, b = boxes[j]!;
      expect(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y).toBe(false);
    }
  });

  it('detaches cyclic and non-composite owners safely', () => {
    const doc = schema();
    doc.attributes.find(a => a.id === 'billing')!.ownerId = 'address';
    const normalized = normalizeDocument(doc);
    expect(normalized.attributes.find(a => a.id === 'billing')!.ownerId).toBeNull();
    expect(normalized.attributes.find(a => a.id === 'address')!.ownerId).toBeNull();
    doc.attributes.find(a => a.id === 'billing')!.ownerId = 'leaf';
    expect(normalizeDocument(doc).attributes.find(a => a.id === 'billing')!.ownerId).toBeNull();
  });

  it('keeps a manually placed bend through JSON and portable links', () => {
    const doc = schema();
    doc.relationships = [{ id: 'r', name: 'owns', x: 0, y: 0, kind: 'strong', bendX: 400, bendY: -700 }];
    for (const result of [normalizeDocument(doc), decodeSnapshot(encodeSnapshot(doc))]) {
      expect(result!.relationships[0]).toMatchObject({ bendX: 400, bendY: -700 });
    }
  });

  it('keeps independent segment positions through JSON, portable links and peer updates', () => {
    const doc = schema();
    const routePoints = [{ x: 300, y: 166 }, { x: 300, y: -40 }, { x: 550, y: -40 }, { x: 550, y: 166 }];
    doc.relationships = [{ id: 'r', name: 'owns', x: 0, y: 0, kind: 'strong', routePoints }];
    const alice = new Y.Doc(), bob = new Y.Doc();
    seedDocument(alice, doc); Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
    for (const result of [normalizeDocument(doc), decodeSnapshot(encodeSnapshot(doc)), snapshotFromYdoc(bob)]) {
      expect(result!.relationships[0]!.routePoints).toEqual(routePoints);
    }
    alice.destroy(); bob.destroy();
    doc.relationships[0]!.routePoints = [{ x: 0, y: 0 }, { x: 10, y: 10 }];
    expect(normalizeDocument(doc).relationships[0]!.routePoints).toBeUndefined();
  });

  it('infers a leaf type from the original leaf name, not its composite ancestors', () => {
    const doc = schema();
    doc.attributes = [
      { id: 'p', name: 'Code', kind: 'composite', ownerId: 'e', x: 0, y: 0 },
      { id: 'v', name: 'Value', kind: 'simple', ownerId: 'p', x: 0, y: 0 },
    ];
    expect(deriveTables(doc)[0]!.rows.find(r => r.attributeId === 'v')).toMatchObject({ name: 'code_value', type: 'TEXT' });
    expect(generateSql(doc)).toContain('"code_value" TEXT');
  });

  it.each([['Active', 'BOOL', 'BOOLEAN'], ['Amount', 'NUMERIC', 'NUMERIC']])(
    'retains the automatic type of %s without treating it as a chosen parameterized type', (name, type, sqlType) => {
      const doc = schema();
      doc.attributes = [
        { id: 'p', name: 'Code', kind: 'composite', ownerId: 'e', x: 0, y: 0 },
        { id: 'v', name, kind: 'simple', ownerId: 'p', x: 0, y: 0 },
      ];
      expect(deriveTables(doc)[0]!.rows.find(r => r.attributeId === 'v')!.type).toBe(type);
      const sql = generateSql(doc);
      expect(sql).toContain(`"code_${name.toLowerCase()}" ${sqlType}`);
      expect(sql).not.toContain('NUMERIC(10,2)');
    });
});
