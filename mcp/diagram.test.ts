import { describe, expect, it } from 'vitest';
import { readFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addAttribute,
  addEntity,
  addIsa,
  createDiagram,
  getDiagram,
  serverStatus,
  updateNode,
  useWorkspace,
  workspaceLabel,
} from '../mcp/diagram';
import { FileWorkspace } from './fileWorkspace';
import {
  leaveRoom,
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

// The service takes its storage by injection now, so the suite points it at the
// checkout the same way a local run does.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
useWorkspace(new FileWorkspace({ root: REPO_ROOT }));

describe('diagram service', () => {
  it('builds, places, and summarizes a diagram', async () => {
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

  it('keeps the coordinates the caller gives instead of arranging', async () => {
    const result = await createDiagram({
      name: 'Placed', save: false,
      entities: [
        { name: 'Left', x: 120, y: 300 },
        { name: 'Right', x: 560, y: 300 },
      ],
      relationships: [{ name: 'links', from: 'Left', to: 'Right', cardinality: 'N:M' }],
    });
    expect(result.summary.entities.map((entity) => entity.position)).toEqual([
      { x: 120, y: 300 },
      { x: 560, y: 300 },
    ]);
    expect(result.outline).toContain('Left [strong] ent_left at (120, 300)');
    const { document } = getDiagram();
    expect(document.entities.map((entity) => [entity.x, entity.y])).toEqual([[120, 300], [560, 300]]);
  });

  it('places unplaced entities around the ones that already have a home', async () => {
    await createDiagram({
      name: 'Mixed', save: false,
      entities: [{ name: 'Fixed', x: 120, y: 120 }, { name: 'Loose' }],
    });
    const loose = getDiagram().document.entities.find((entity) => entity.name === 'Loose')!;
    expect([loose.x, loose.y]).not.toEqual([120, 120]);
    expect([loose.x, loose.y]).not.toEqual([0, 0]);
  });

  it('runs the layout engine over a spec that gives no coordinates', async () => {
    await createDiagram({ ...baseSpec(), name: 'Arranged', save: false });
    const doc = getDiagram().document;

    // Nothing stacks on anything else: the engine separates the whole
    // drawing, where the free-slot grid it used to fall back to stacked
    // relationships on their owners.
    const boxes = [
      ...doc.entities.map((node) => ({ ...node, w: 150, h: 60 })),
      ...doc.relationships.map((node) => ({ ...node, w: 150, h: 72 })),
    ];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!, b = boxes[j]!;
        const overlap =
          a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap).toBe(false);
      }
    }
    // And the relationship is drawn somewhere, not left at the origin the
    // authored placement path leaves free-slot shapes on.
    const places = doc.relationships.find((relationship) => relationship.name === 'places')!;
    expect([places.x, places.y]).not.toEqual([0, 0]);
  });

  it('rejects half a coordinate', async () => {
    await expect(createDiagram({
      name: 'Half', save: false,
      entities: [{ name: 'A', x: 10 }],
    })).rejects.toThrow(/both x and y/);
  });

  it('writes a specialization as one shape over the parent entity', async () => {
    await createDiagram({
      name: 'Isa', save: false,
      entities: [{ name: 'Person', x: 100, y: 200 }, { name: 'Customer' }, { name: 'Employee' }],
    });
    const doc = getDiagram().document;
    const base = doc.entities.find(({ name }) => name === 'Person')!;
    const children = doc.entities.filter(({ name }) => ['Customer', 'Employee'].includes(name));
    const result = await addIsa({ parent: base.id, children: children.map(({ id }) => id) });
    expect(result.nodeId).toMatch(/^isa_/);
    const { isas } = getDiagram().document;
    expect(isas.length).toBe(1);
    expect(isas[0]!.parentId).toBe(base.id);
    expect(isas[0]!.childIds).toEqual(children.map(({ id }) => id));
    // The shape keeps the parent in place, a square above it.
    expect(isas[0]!.x).toBe(base.x);
    expect(isas[0]!.y).toBe(base.y - NODE_SIZE.isa.h - 16);
  });

  it('extends a specialization when the base is given again', async () => {
    await createDiagram({
      name: 'Isa extends', save: false,
      entities: [{ name: 'Person', x: 100, y: 200 }, { name: 'Customer' }, { name: 'Employee' }],
    });
    const doc = getDiagram().document;
    const base = doc.entities.find(({ name }) => name === 'Person')!;
    const [first] = doc.entities.filter(({ name }) => ['Customer', 'Employee'].includes(name));
    await addIsa({ parent: base.id, children: [first!.id] });
    expect(getDiagram().document.isas.length).toBe(1);
    expect(getDiagram().document.isas[0]!.childIds).toEqual([first!.id]);
    const others = doc.entities.filter(({ name }) => ['Customer', 'Employee'].includes(name)).map(({ id }) => id);
    await addIsa({ parent: base.id, children: others });
    expect(getDiagram().document.isas[0]!.childIds).toEqual(others);
  });

  it('reports the open diagram through server_status', async () => {
    await createDiagram({
      name: 'Status', save: false,
      entities: [{ name: 'A', attributes: [{ name: 'a_id', kind: 'key' }] }],
    });
    const status = serverStatus();
    expect(status.alive).toBe(true);
    expect(status.workspace).toBe(workspaceLabel());
    expect(status.open?.name).toBe('Status');
    expect(status.open?.shapes).toEqual({ entities: 1, attributes: 1, relationships: 0, isas: 0 });
    expect(status.open?.filePath).toBeNull();
  });

  it('keeps a crow\'s-foot table at the given point', async () => {
    const result = await createDiagram({
      name: 'Tables', view: 'crowfoot', save: false,
      entities: [{ name: 'Account', x: 300, y: 200, attributes: [{ name: 'account_id', kind: 'key' }] }],
    });
    expect(result.summary.entities[0]!.position).toEqual({ x: 300, y: 200 });
    const entity = getDiagram().document.entities[0]!;
    expect([entity.crowX, entity.crowY]).toEqual([300, 200]);
  });

  it('moves an entity and carries its attributes', async () => {
    await createDiagram(baseSpec());
    const before = getDiagram().document;
    const entity = before.entities.find((candidate) => candidate.name === 'Customer')!;
    const attribute = before.attributes.find((candidate) => candidate.name === 'email')!;
    const dx = 400 - entity.x;
    const dy = 260 - entity.y;
    const outcome = await updateNode('Customer', { x: 400, y: 260 });
    expect(outcome.message).toBe('Moved entity Customer to (400, 260).');
    expect(outcome.position).toEqual({ x: 400, y: 260 });
    const after = getDiagram().document;
    expect(after.entities.find((candidate) => candidate.name === 'Customer')).toMatchObject({ x: 400, y: 260 });
    expect(after.attributes.find((candidate) => candidate.name === 'email')).toMatchObject({
      x: attribute.x + dx,
      y: attribute.y + dy,
    });
  });

  it('moves a crow\'s-foot table without disturbing its Chen position', async () => {
    await createDiagram({ ...baseSpec(), view: 'crowfoot' });
    const entity = getDiagram().document.entities.find((candidate) => candidate.name === 'Customer')!;
    const outcome = await updateNode('Customer', { x: 640, y: 480 });
    expect(outcome.position).toEqual({ x: 640, y: 480 });
    const after = getDiagram().document.entities.find((candidate) => candidate.name === 'Customer')!;
    expect([after.crowX, after.crowY]).toEqual([640, 480]);
    expect([after.x, after.y]).toEqual([entity.x, entity.y]);
  });

  it('refuses to move anything but an entity, and needs both axes', async () => {
    await createDiagram(baseSpec());
    await expect(updateNode('places', { x: 10, y: 10 })).rejects.toThrow(/Only entities/);
    await expect(updateNode('Customer', { x: 10 })).rejects.toThrow(/both x and y/);
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

  it('adds an entity at the coordinates it was given', async () => {
    await createDiagram(baseSpec());
    const outcome = await addEntity({ name: 'Product', x: 900, y: 620 });
    expect(outcome.position).toEqual({ x: 900, y: 620 });
    const entity = getDiagram().document.entities.find((candidate) => candidate.name === 'Product')!;
    expect([entity.x, entity.y]).toEqual([900, 620]);
    const summary = (await summarizeSession()).summary;
    expect(summary.entities.find((candidate) => candidate.name === 'Product')!.position).toEqual({ x: 900, y: 620 });
  });

  it('leaves a room nothing is watching without touching the diagram', async () => {
    await createDiagram(baseSpec());
    const left = await leaveRoom();
    expect(left.room).toBeNull();
    expect(left.message).toMatch(/not in a live room/i);
    expect(getDiagram().document.entities).toHaveLength(2);
  });

  it('adds a crow\'s-foot table at the coordinates it was given', async () => {
    await createDiagram({ ...baseSpec(), view: 'crowfoot' });
    const outcome = await addEntity({
      name: 'Product', x: 900, y: 620,
      attributes: [{ name: 'product_id', kind: 'key' }, { name: 'price' }],
    });
    expect(outcome.position).toEqual({ x: 900, y: 620 });
    const entity = getDiagram().document.entities.find((candidate) => candidate.name === 'Product')!;
    expect([entity.crowX, entity.crowY]).toEqual([900, 620]);
  });
});
