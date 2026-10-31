/**
 * Measures layout tightness for both suites: synthetic shapes and a realistic
 * seventeen-entity shop schema.
 *
 * The shop schema is the one the visual comparison uses, so it has to be
 * measured alongside the synthetic cases. Optimising only the synthetic suite
 * is how a previous change looked like a 11% win while making the realistic
 * diagram 8% worse.
 *
 *   npx tsx scripts/measure-layout.ts          # print the table
 *   npx tsx scripts/measure-layout.ts --save   # record a baseline
 */

import { applyLayout, sizeFor } from '../src/model/layout';
import { emptyDocument, type ErdDocument } from '../src/model/types';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

/** Sum of node areas, and the bounding box they occupy. */
function measure(doc: ErdDocument) {
  const nodes = [...doc.entities, ...doc.relationships, ...doc.attributes, ...doc.isas];
  const boxes = nodes.map((node) => ({ ...node, ...sizeFor(doc, node.id) }));
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  const width = right - left, height = bottom - top;
  const area = width * height;
  const used = boxes.reduce((sum, b) => sum + b.w * b.h, 0);
  return { width: Math.round(width), height: Math.round(height), area: Math.round(area),
    density: Number((used / area).toFixed(3)) };
}

/** Two entities joined through one relationship. */
function chain(): ErdDocument {
  const doc = emptyDocument();
  doc.entities.push(
    { id: 'e1', name: 'Customer', x: 0, y: 0, kind: 'strong' },
    { id: 'e2', name: 'Order', x: 0, y: 0, kind: 'strong' },
  );
  doc.relationships.push({ id: 'r1', name: 'places', x: 0, y: 0, kind: 'strong' });
  doc.legs.push(
    { id: 'l1', fromId: 'e1', toId: 'r1', cardinality: '1', participation: { min: 0, max: 1 } },
    { id: 'l2', fromId: 'r1', toId: 'e2', cardinality: 'N', participation: { min: 0, max: 'N' } },
  );
  doc.attributes.push(
    { id: 'a1', name: 'id', kind: 'key', ownerId: 'e1', x: 0, y: 0 },
    { id: 'a2', name: 'name', kind: 'simple', ownerId: 'e1', x: 0, y: 0 },
    { id: 'a3', name: 'total', kind: 'simple', ownerId: 'e2', x: 0, y: 0 },
  );
  return doc;
}

/** One hub entity with six relationships and attributes on each. */
function star(): ErdDocument {
  const doc = emptyDocument();
  doc.entities.push({ id: 'hub', name: 'Account', x: 0, y: 0, kind: 'strong' });
  doc.attributes.push(
    { id: 'hub-a0', name: 'id', kind: 'key', ownerId: 'hub', x: 0, y: 0 },
    { id: 'hub-a1', name: 'name', kind: 'simple', ownerId: 'hub', x: 0, y: 0 },
  );
  for (let i = 0; i < 6; i++) {
    const id = `e${i}`, rel = `r${i}`;
    doc.entities.push({ id, name: `Satellite ${i}`, x: 0, y: 0, kind: 'strong' });
    doc.attributes.push({ id: `${id}-a0`, name: 'id', kind: 'key', ownerId: id, x: 0, y: 0 });
    doc.relationships.push({ id: rel, name: 'links', x: 0, y: 0, kind: 'strong' });
    doc.legs.push(
      { id: `${rel}a`, fromId: 'hub', toId: rel, cardinality: '1', participation: { min: 0, max: 1 } },
      { id: `${rel}b`, fromId: rel, toId: id, cardinality: 'N', participation: { min: 0, max: 'N' } },
    );
  }
  return doc;
}

/**
 * Seventeen entities with real fan-outs, including one owner with seven
 * attributes, which is the shape that decides whether the compact engine or the
 * layered one runs.
 */
function shop(): ErdDocument {
  const doc = emptyDocument();
  const entities: Array<[string, string[]]> = [
    ['Customer', ['customer_id:key', 'email', 'name', 'phone', 'created_at', 'loyalty_tier', 'marketing_opt_in']],
    ['Address', ['address_id:key', 'line1', 'line2', 'city', 'region', 'postcode', 'country']],
    ['Order', ['order_id:key', 'placed_at', 'status', 'total', 'currency', 'discount_code']],
    ['OrderLine', ['line_id:key', 'quantity', 'unit_price', 'line_total']],
    ['Product', ['product_id:key', 'sku', 'title', 'description', 'price', 'weight_kg', 'active']],
    ['Category', ['category_id:key', 'name', 'slug', 'parent_id']],
    ['Inventory', ['inventory_id:key', 'on_hand', 'reserved', 'reorder_point']],
    ['Warehouse', ['warehouse_id:key', 'code', 'city', 'capacity']],
    ['Supplier', ['supplier_id:key', 'name', 'contact_email', 'lead_days']],
    ['PurchaseOrder', ['po_id:key', 'issued_at', 'received_at', 'status']],
    ['Payment', ['payment_id:key', 'method', 'amount', 'captured_at', 'reference']],
    ['Refund', ['refund_id:key', 'amount', 'reason', 'issued_at']],
    ['Shipment', ['shipment_id:key', 'tracking', 'carrier', 'dispatched_at']],
    ['Review', ['review_id:key', 'rating', 'body', 'published_at']],
    ['Coupon', ['coupon_id:key', 'code', 'percent_off', 'expires_at']],
    ['Employee', ['employee_id:key', 'full_name', 'role', 'hired_at']],
    ['AuditLog', ['entry_id:key', 'actor', 'action', 'at']],
  ];
  for (const [name, attrs] of entities) {
    const key = name.toLowerCase().replace(/[^a-z]/g, '');
    doc.entities.push({ id: key, name, x: 0, y: 0, kind: 'strong' });
    attrs.forEach((attr, i) => {
      const [label, kind] = attr.split(':');
      doc.attributes.push({ id: `${key}_a${i}`, name: label!, kind: kind === 'key' ? 'key' : 'simple', ownerId: key, x: 0, y: 0 });
    });
  }
  const links: Array<[string, string, string]> = [
    ['customer', 'order', 'places'], ['customer', 'address', 'has'], ['customer', 'review', 'writes'],
    ['customer', 'payment', 'pays'], ['order', 'orderline', 'contains'], ['orderline', 'product', 'refers'],
    ['order', 'shipment', 'ships'], ['order', 'coupon', 'applies'], ['product', 'category', 'belongs'],
    ['product', 'inventory', 'stocked'], ['inventory', 'warehouse', 'held'], ['product', 'supplier', 'sourced'],
    ['supplier', 'purchaseorder', 'receives'], ['purchaseorder', 'warehouse', 'delivers'],
    ['payment', 'refund', 'reverses'], ['shipment', 'warehouse', 'leaves'],
    ['employee', 'warehouse', 'works'], ['employee', 'auditlog', 'writes'],
  ];
  links.forEach(([from, to, verb], i) => {
    doc.relationships.push({ id: `r${i}`, name: verb, x: 0, y: 0, kind: 'strong' });
    doc.legs.push(
      { id: `r${i}a`, fromId: from, toId: `r${i}`, cardinality: '1', participation: { min: 0, max: 1 } },
      { id: `r${i}b`, fromId: `r${i}`, toId: to, cardinality: 'N', participation: { min: 0, max: 'N' } },
    );
  });
  return doc;
}

/** A thirty-entity mesh, which forces the layered engine. */
function mesh(): ErdDocument {
  const doc = emptyDocument();
  for (let i = 0; i < 30; i++) {
    const id = `e${String(i).padStart(2, '0')}`;
    doc.entities.push({ id, name: `Entity ${i}`, x: 0, y: 0, kind: 'strong' });
    for (let a = 0; a < 8; a++) {
      doc.attributes.push({ id: `${id}-a${a}`, name: `Field ${a}`, ownerId: id, kind: a ? 'simple' : 'key', x: 0, y: 0 });
    }
    if (i === 0) continue;
    for (const parent of new Set([i - 1, Math.max(0, i - 5)])) {
      const rel = `r${i}-${parent}`;
      doc.relationships.push({ id: rel, name: 'connects', kind: 'strong', x: 0, y: 0 });
      doc.legs.push(
        { id: `${rel}-a`, fromId: `e${String(parent).padStart(2, '0')}`, toId: rel, cardinality: '1', participation: { min: 0, max: 1 } },
        { id: `${rel}-b`, fromId: rel, toId: id, cardinality: 'N', participation: { min: 0, max: 'N' } },
      );
    }
  }
  return doc;
}

const SUITES: Array<[string, () => ErdDocument]> = [
  ['chain', chain], ['star', star], ['shop', shop], ['mesh', mesh],
];

const rows = SUITES.map(([name, build]) => {
  const laid = applyLayout(build());
  return [name, measure(laid)] as const;
});

const totalArea = rows.reduce((sum, [, m]) => sum + m.area, 0);
const totalUsed = rows.reduce((sum, [name, m]) => sum + m.area * m.density, 0);
const summary = { width: 0, height: 0, area: totalArea, density: Number((totalUsed / totalArea).toFixed(3)) };

console.log('suite      width  height      area  density');
for (const [name, m] of rows) {
  console.log(name.padEnd(10), String(m.width).padStart(5), String(m.height).padStart(7),
    String(m.area).padStart(9), String(m.density).padStart(8));
}
console.log('TOTAL'.padEnd(10), ' '.repeat(5), ' '.repeat(7), String(summary.area).padStart(9), String(summary.density).padStart(8));

const baselinePath = 'scripts/layout-baseline.json';
if (process.argv.includes('--save')) {
  writeFileSync(baselinePath, JSON.stringify({ rows: Object.fromEntries(rows), summary }, null, 2));
  console.log('\nbaseline saved');
} else if (existsSync(baselinePath)) {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  console.log('\nvs baseline');
  let regressed = false;
  for (const [name, m] of rows) {
    const before = baseline.rows[name];
    if (!before) continue;
    const delta = ((m.area - before.area) / before.area) * 100;
    const flag = delta > 0.5 ? '  REGRESSED' : delta < -0.5 ? '  better' : '';
    if (delta > 0.5) regressed = true;
    console.log(' ', name.padEnd(10), `${before.area} -> ${m.area}`.padStart(24),
      `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`.padStart(8), flag);
  }
  const delta = ((summary.area - baseline.summary.area) / baseline.summary.area) * 100;
  console.log('  TOTAL'.padEnd(12), `${baseline.summary.area} -> ${summary.area}`.padStart(24),
    `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`.padStart(8));
  console.log(regressed ? '\nFAIL: at least one suite regressed' : '\nPASS: no suite regressed');
}
