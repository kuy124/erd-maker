import { describe, expect, it } from 'vitest';
import { readFile, unlink } from 'node:fs/promises';
import {
  addAttribute,
  addEntity,
  createDiagram,
  getDiagram,
  listDiagramFiles,
  openDiagram,
  removeDiagramNode,
  resolveDiagramPath,
  saveDiagram,
  shareSession,
  sqlForSession,
  summarizeSession,
  validateSession,
  type AttributeSpec,
  type CreateSpec,
} from './diagram';
import { NODE_SIZE } from '../src/model/types';

const customer: AttributeSpec[] = [
  { name: 'customer_id', kind: 'key', dataType: 'INT' },
  { name: 'email', kind: 'unique', dataType: 'VARCHAR(160)' },
];

function baseSpec(): CreateSpec {
  return {
    name: 'Sales',
    save: false,
    entities: [
      { name: 'Customer', attributes: customer },
      { name: 'Order', attributes: [
        { name: 'order_id', kind: 'key', dataType: 'INT' },
        { name: 'placed_at', dataType: 'TIMESTAMP' },
      ] },
    ],
    relationships: [{ name: 'places', from: 'Customer', to: 'Order', cardinality: '1:N' as const }],
  };
}

describe('diagram service', () => {
  it('builds, lays out, and summarizes a diagram', async () => {
    const result = await createDiagram(baseSpec());
    expect(result.filePath).toBeNull();
    expect(result.summary.counts).toEqual({ entities: 2, attributes: 4, relationships: 1, specializations: 0 });
    const ends = result.summary.relationships[0]!.ends;
    const byName = new Map(ends.map((end) => [end.entityName, end]));
    expect(byName.get('Customer')).toMatchObject({ cardinality: '1', participation: { min: 0, max: 1 } });
    expect(byName.get('Order')).toMatchObject({ cardinality: 'N', participation: { min: 0, max: 'N' } });
    expect(result.outline).toContain('Customer');
    expect(new Set(result.summary.entities.map((entity) => entity.id)).size).toBe(2);
  });

  it('places a new attribute beside its owner instead of on top of it', async () => {
    const result = await createDiagram(baseSpec());
    const doc = (await summarizeSession()).summary;
    expect(doc.relationships[0]!.name).toBe('places');
    await addAttribute({ owner: 'Customer', name: 'loyalty_tier', dataType: 'VARCHAR(20)' });
    const { document } = getDiagram();
    const entity = document.entities.find((candidate) => candidate.name === 'Customer')!;
    const attribute = document.attributes.find((candidate) => candidate.name === 'loyalty_tier')!;
    const entityBox = { x: entity.x, y: entity.y, ...NODE_SIZE.entity };
    const attributeBox = { x: attribute.x, y: attribute.y, ...NODE_SIZE.attribute };
    const overlaps = attributeBox.x < entityBox.x + entityBox.w &&
      attributeBox.x + attributeBox.w > entityBox.x &&
      attributeBox.y < entityBox.y + entityBox.h &&
      attributeBox.y + attributeBox.h > entityBox.y;
    expect(overlaps).toBe(false);
    expect(result.summary.counts.attributes).toBe(4);
  });

  it('leaves the diagram untouched when a nested attribute fails validation', async () => {
    await createDiagram(baseSpec());
    const before = (await summarizeSession()).summary.counts.attributes;
    await expect(addAttribute({
      owner: 'Customer',
      name: 'address',
      kind: 'composite',
      attributes: [{ name: 'street' }, { name: 'zip', dataType: 'NOT_A_TYPE' }],
    })).rejects.toThrow(/Unknown data type/);
    const after = (await summarizeSession()).summary.counts.attributes;
    expect(after).toBe(before);
  });

  it('generates SQL that matches the derived tables', async () => {
    await createDiagram(baseSpec());
    const { sql } = sqlForSession('postgres');
    expect(sql).toContain('CREATE TABLE "customer"');
    expect(sql).toContain('CREATE TABLE "order"');
    expect(sql).toContain('PRIMARY KEY ("customer_id")');
    expect(sql).toContain('FOREIGN KEY');
  });

  it('reports missing keys as validation issues', async () => {
    await createDiagram({ name: 'Loose', save: false, entities: [{ name: 'Thing', attributes: [{ name: 'label' }] }] });
    const { valid, issues, sqlReadiness } = validateSession();
    expect(valid).toBe(false);
    expect(issues.some((issue) => issue.code === 'missing-key')).toBe(true);
    expect(sqlReadiness).not.toBe('Ready.');
  });

  it('rejects duplicate entity names and bad cardinality before touching the session', async () => {
    await expect(createDiagram({
      name: 'Broken', save: false,
      entities: [{ name: 'A' }, { name: 'a' }],
    })).rejects.toThrow(/Duplicate entity name/);
    await expect(createDiagram({
      name: 'Broken', save: false,
      entities: [{ name: 'A' }, { name: 'B' }],
      relationships: [{ name: 'r', from: 'A', to: 'B', cardinality: 'one-to-many' }],
    })).rejects.toThrow(/Cardinality/);
  });

  it('removes descendants with their owner', async () => {
    await createDiagram({
      name: 'Parts', save: false,
      entities: [{ name: 'Person', attributes: [{
        name: 'name',
        kind: 'composite',
        attributes: [{ name: 'first' }, { name: 'last' }],
      }] }],
    });
    const before = (await summarizeSession()).summary.counts.attributes;
    expect(before).toBe(3);
    await removeDiagramNode('Person');
    const after = (await summarizeSession()).summary.counts.attributes;
    expect(after).toBe(0);
  });

  it('keeps Chen coordinates when a crow\'s-foot diagram is created', async () => {
    const result = await createDiagram({ ...baseSpec(), view: 'crowfoot' });
    expect(result.summary.view).toBe('crowfoot');
    const { document } = getDiagram();
    expect(document.entities.every((entity) => typeof entity.crowX === 'number' && typeof entity.crowY === 'number')).toBe(true);
    expect(document.entities.every((entity) => Number.isFinite(entity.x) && Number.isFinite(entity.y))).toBe(true);
  });

  it('keeps diagram paths inside the workspace and requires .json', () => {
    expect(resolveDiagramPath('diagrams/ok.json').endsWith('ok.json')).toBe(true);
    expect(() => resolveDiagramPath('../outside.json')).toThrow(/inside/);
    expect(() => resolveDiagramPath('notes.txt')).toThrow(/\.json/);
  });
});

describe('diagram files', () => {
  const path = `diagrams/mcp-test-${process.pid}.json`;

  it('saves, lists, opens, and refuses to overwrite another file', async () => {
    try {
      const created = await createDiagram({ ...baseSpec(), save: false });
      expect(created.summary.name).toBe('Sales');
      const saved = await saveDiagram(path);
      expect(saved.endsWith('mcp-test-' + process.pid + '.json')).toBe(true);
      const stored = JSON.parse(await readFile(saved, 'utf8')) as { name: string; entities: unknown[] };
      expect(stored.name).toBe('Sales');
      expect(stored.entities).toHaveLength(2);

      const listed = await listDiagramFiles();
      expect(listed.some((file) => file.path === path && file.name === 'Sales')).toBe(true);

      await createDiagram({ ...baseSpec(), name: 'Other', save: false });
      await expect(saveDiagram(path)).rejects.toThrow(/already exists/);

      const opened = await openDiagram(path);
      expect(opened.summary.name).toBe('Sales');

      const share = shareSession({ baseUrl: 'https://erd.example.com/' });
      expect(share.url.startsWith('https://erd.example.com/#room=')).toBe(true);
      expect(share.hash).toContain('d=');
    } finally {
      await unlink(resolveDiagramPath(path)).catch(() => undefined);
    }
  });

  it('adds an entity at the first free slot', async () => {
    await createDiagram(baseSpec());
    const outcome = await addEntity({ name: 'Product', attributes: [{ name: 'product_id', kind: 'key', dataType: 'INT' }] });
    expect(outcome.nodeId).toContain('ent_product');
    expect(outcome.issues.every((issue) => issue.nodeId !== outcome.nodeId || issue.code !== 'unnamed')).toBe(true);
  });
});
