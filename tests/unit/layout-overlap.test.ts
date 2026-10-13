import { describe, expect, it } from 'vitest';
import { autoArrange, applyLayout } from '../../src/model/layout';
import { deriveTables, tableHeight } from '../../src/model/crowfoot';
import { emptyDocument, type ErdDocument } from '../../src/model/types';

function schema(tables: number, attrs: number): ErdDocument {
  const doc = emptyDocument('Warehouse');
  for (let t = 0; t < tables; t += 1) {
    const e = `e${t}`;
    doc.entities.push({ id: e, name: `Table ${t} entity name`, kind: 'strong', x: 0, y: 0 });
    for (let a = 0; a < attrs; a += 1) {
      doc.attributes.push({
        id: `a${t}_${a}`, name: `column_${a}_descriptor`, kind: a === 0 ? 'key' : 'simple', ownerId: e, x: 0, y: 0,
      });
    }
    if (t > 0) {
      doc.relationships.push({ id: `r${t}`, name: 'relates to', kind: 'strong', x: 0, y: 0 });
      doc.legs.push({ id: `l${t}a`, fromId: `r${t}`, toId: `e${t - 1}`, cardinality: '1', participation: { min: 0, max: 1 } });
      doc.legs.push({ id: `l${t}b`, fromId: `r${t}`, toId: e, cardinality: 'N', participation: { min: 0, max: 'N' }, columnId: `attribute:a${t}_1` });
    }
  }
  return doc;
}

type Box = { id: string; x: number; y: number; w: number; h: number };

function boxes(doc: ErdDocument): Box[] {
  const out: Box[] = [];
  if (doc.view === 'crowfoot') {
    for (const table of deriveTables(doc)) {
      out.push({ id: table.entityId, x: table.x, y: table.y, w: table.width, h: tableHeight(table) });
    }
    return out;
  }
  const NODE = { entity: { w: 130, h: 72 }, attribute: { w: 130, h: 42 }, relationship: { w: 150, h: 72 }, isa: { w: 90, h: 40 } };
  for (const e of doc.entities) out.push({ id: e.id, x: e.x, y: e.y, ...NODE.entity });
  for (const r of doc.relationships) out.push({ id: r.id, x: r.x, y: r.y, ...NODE.relationship });
  for (const i of doc.isas) out.push({ id: i.id, x: i.x, y: i.y, ...NODE.isa });
  for (const a of doc.attributes) out.push({ id: a.id, x: a.x, y: a.y, ...NODE.attribute });
  return out;
}

function overlaps(list: Box[]): string[] {
  const hits: string[] = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i]!, b = list[j]!;
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      if (overlap) hits.push(`${a.id} x ${b.id}`);
    }
  }
  return hits;
}

describe('applyLayout (what Tidy actually calls)', () => {
  it('leaves no overlap in crow-foot', () => {
    for (const [tables, attrs] of [[3, 4], [8, 6], [20, 12]] as const) {
      const doc = schema(tables, attrs);
      doc.view = 'crowfoot';
      const arranged = applyLayout(doc);
      const hits = overlaps(boxes(arranged));
      console.log(`crowfoot ${tables}x${attrs}: ${hits.length} overlaps`, hits.slice(0, 8));
      expect(hits, `crowfoot ${tables}x${attrs}`).toEqual([]);
    }
  });

  it('leaves no overlap in Chen', () => {
    for (const [tables, attrs] of [[3, 4], [8, 6], [20, 12]] as const) {
      const doc = schema(tables, attrs);
      const arranged = applyLayout(doc);
      const hits = overlaps(boxes(arranged));
      console.log(`chen ${tables}x${attrs}: ${hits.length} overlaps`, hits.slice(0, 8));
      expect(hits, `chen ${tables}x${attrs}`).toEqual([]);
    }
  });

  it('leaves no overlap when attributes started scattered far from their owner', () => {
    // Attributes keep their original offset, which is the point: an arrangement
    // the person chose survives. It is also how a wide offset lands on a
    // neighbour, so the awkward case has to be measured too.
    const doc = schema(6, 4);
    doc.view = 'chen';
    for (const attribute of doc.attributes) {
      attribute.x = 2000 + Math.abs(hash(attribute.id) % 400);
      attribute.y = Math.abs(hash(attribute.id + 'y') % 600);
    }
    const arranged = applyLayout(doc);
    const hits = overlaps(boxes(arranged));
    console.log(`scattered chen: ${hits.length} overlaps`, hits.slice(0, 8));
    expect(hits).toEqual([]);
  });
});

function hash(value: string): number {
  let total = 0;
  for (let i = 0; i < value.length; i += 1) total = (total * 31 + value.charCodeAt(i)) | 0;
  return total;
}

describe('autoArrange', () => {
  it('leaves no overlap in crow-foot, however big the schema', () => {
    for (const [tables, attrs] of [[3, 4], [8, 6], [20, 12]] as const) {
      const doc = schema(tables, attrs);
      doc.view = 'crowfoot';
      const arranged = { ...doc, entities: doc.entities.map((e) => ({ ...e })) };
      const { positions } = autoArrange(doc);
      for (const [id, point] of positions) {
        if (doc.entities.some((e) => e.id === id)) {
          const entity = arranged.entities.find((e) => e.id === id)!;
          entity.x = point.x; entity.y = point.y;
        }
      }
      const hits = overlaps(boxes(arranged));
      console.log(`crowfoot ${tables}x${attrs}: ${hits.length} overlaps`, hits.slice(0, 6));
      expect(hits, `crowfoot ${tables}x${attrs}`).toEqual([]);
    }
  });

  it('leaves no overlap in Chen', () => {
    for (const [tables, attrs] of [[3, 4], [8, 6], [20, 12]] as const) {
      const doc = schema(tables, attrs);
      const { positions } = autoArrange(doc);
      const placed: Box[] = [];
      for (const [id, point] of positions) {
        const box = boxes(doc).find((b) => b.id === id);
        if (box) placed.push({ ...box, x: point.x, y: point.y });
      }
      const hits = overlaps(placed);
      console.log(`chen ${tables}x${attrs}: ${hits.length} overlaps`, hits.slice(0, 6));
      expect(hits, `chen ${tables}x${attrs}`).toEqual([]);
    }
  });
});