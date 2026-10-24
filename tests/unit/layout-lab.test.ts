/** Temporary Auto-arrange lab: big schema, metrics, PNGs. Not a regression test. */
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { test, expect } from 'vitest';
import { applyLayout, sizeFor } from '../../src/model/layout';
import { deriveTables, deriveLinks, routeColumns, tableHeight } from '../../src/model/crowfoot';
import { emptyDocument, type ErdDocument } from '../../src/model/types';
import { measure, renderSvg, type Box, type Edge } from './layout-lab';

const TABLES: Record<string, string[]> = {
  Customer: ['customer_id', 'email', 'phone_number', 'signup_channel', 'loyalty_tier'],
  Order: ['order_id', 'status', 'placed_at', 'total_amount', 'coupon_code'],
  OrderItem: ['order_item_id', 'quantity', 'unit_price', 'line_note'],
  Product: ['product_id', 'title', 'sku', 'unit_price', 'weight_grams', 'description_text'],
  Category: ['category_id', 'name', 'slug', 'description'],
  ProductCategory: ['product_category_id'],
  Review: ['review_id', 'stars', 'body_text', 'created_at'],
  Address: ['address_id', 'street_line', 'city', 'region', 'postal_code', 'country_code'],
  Payment: ['payment_id', 'method', 'amount_charged', 'paid_at'],
  Refund: ['refund_id', 'amount', 'reason'],
  Shipment: ['shipment_id', 'tracking_code', 'shipped_at', 'delivery_note'],
  Carrier: ['carrier_id', 'name', 'service_level'],
  Warehouse: ['warehouse_id', 'name', 'capacity'],
  StockUnit: ['stock_unit_id', 'quantity_on_hand', 'bin_location'],
  Supplier: ['supplier_id', 'company_name', 'contact_email'],
  ProductSupplier: ['product_supplier_id'],
  PurchaseOrder: ['purchase_order_id', 'ordered_at', 'expected_at'],
  PurchaseOrderLine: ['po_line_id', 'quantity', 'contract_price'],
  Employee: ['employee_id', 'full_name', 'email', 'hired_at', 'hourly_rate'],
  Department: ['department_id', 'name', 'floor'],
  Store: ['store_id', 'name', 'opening_hours'],
  Shift: ['shift_id', 'starts_at', 'ends_at'],
  Ticket: ['ticket_id', 'subject_line', 'state'],
  AgentNote: ['note_id', 'body'],
  Wishlist: ['wishlist_id', 'name'],
  WishItem: ['wish_item_id', 'added_at'],
  Role: ['role_id', 'name', 'level'],
  UserAccount: ['user_account_id', 'login', 'created_at'],
  SessionToken: ['session_token_id', 'issued_at', 'expires_at'],
  AuditLog: ['audit_log_id', 'action', 'recorded_at'],
  FeatureFlag: ['feature_flag_id', 'flag_key', 'rollout_percent'],
};

/** label, one-side, many-side (or 1:1 via ratio param). */
const LINKS: [string, string, string][] = [
  ['places', 'Customer', 'Order'], ['contains', 'Order', 'OrderItem'],
  ['categorises', 'Product', 'ProductCategory'], ['classifies', 'Category', 'ProductCategory'],
  ['refs', 'OrderItem', 'Product'], ['reviews', 'Customer', 'Review'],
  ['reviewed', 'Product', 'Review'], ['ships to', 'Customer', 'Address'],
  ['billed to', 'Customer', 'Address'], ['pays for', 'Order', 'Payment'],
  ['refunds', 'Payment', 'Refund'], ['ships', 'Order', 'Shipment'],
  ['hauls', 'Shipment', 'Carrier'], ['stored at', 'StockUnit', 'Warehouse'],
  ['stocks', 'StockUnit', 'Product'], ['supplies', 'Supplier', 'PurchaseOrder'],
  ['has line', 'PurchaseOrder', 'PurchaseOrderLine'], ['supplied as', 'PurchaseOrderLine', 'Product'],
  ['sourcing', 'Supplier', 'ProductSupplier'], ['stocked from', 'ProductSupplier', 'Product'],
  ['works in', 'Employee', 'Department'], ['staffs', 'Store', 'Employee'],
  ['rosters', 'Shift', 'Employee'], ['covers', 'Shift', 'Store'],
  ['escalates', 'Ticket', 'AgentNote'], ['assists', 'Employee', 'Ticket'],
  ['raises', 'Customer', 'Ticket'], ['owns', 'Customer', 'Wishlist'],
  ['saves', 'WishItem', 'Wishlist'], ['wishes', 'WishItem', 'Product'],
  ['grants', 'Role', 'UserAccount'], ['session of', 'UserAccount', 'SessionToken'],
  ['records', 'UserAccount', 'AuditLog'], ['manages', 'Employee', 'Employee'],
  ['headed by', 'Department', 'Employee'], ['created', 'Employee', 'Order'],
];

function crowDoc(): ErdDocument {
  const doc = emptyDocument('lab crow');
  doc.view = 'crowfoot';
  for (const [name, attrs] of Object.entries(TABLES)) {
    const id = 'e_' + name;
    doc.entities.push({ id, name, x: 0, y: 0,
      kind: name === 'ProductCategory' || name === 'ProductSupplier' ? 'associative' : 'strong' });
    attrs.forEach((a, i) => doc.attributes.push({ id: `a_${name}_${i}`, name: a, x: 0, y: 0,
      kind: i === 0 ? 'key' : 'simple', ownerId: id }));
  }
  LINKS.forEach(([label, one, many], index) => {
    const rid = 'r_' + index;
    doc.relationships.push({ id: rid, name: label, x: 0, y: 0, kind: 'strong' });
    doc.legs.push({ id: rid + '_1', fromId: rid, toId: 'e_' + one, cardinality: '1', participation: { min: 0, max: 1 } });
    doc.legs.push({ id: rid + '_N', fromId: rid, toId: 'e_' + many, cardinality: 'N', participation: { min: 0, max: 'N' } });
  });
  return doc;
}

const CHEN_TABLES: Record<string, string[]> = {  Customer: ['customer_id', 'email', 'loyalty_tier', 'address'],
  Order: ['order_id', 'status', 'placed_at'],
  LineItem: ['line_id', 'quantity', 'unit_price'],
  Product: ['product_id', 'title', 'sku'],
  Review: ['review_id', 'stars'],
  Employee: ['employee_id', 'full_name'],
  Department: ['department_id', 'name'],
  Shipment: ['shipment_id', 'tracking_code'],
  Address: ['street_line', 'city', 'postal_code'],
};

function chenDoc(): ErdDocument {
  const doc = emptyDocument('lab chen');
  for (const [name, attrs] of Object.entries(CHEN_TABLES)) {
    const id = 'e_' + name;
    doc.entities.push({ id, name, x: 0, y: 0, kind: 'strong' });
    attrs.forEach((a, i) => doc.attributes.push({ id: `a_${name}_${i}`, name: a, x: 0, y: 0,
      kind: i === 0 && name !== 'Address' ? 'key' : 'simple', ownerId: id }));
  }
  const rel = (label: string, a: string, ac: '1' | 'N' | 'M', b: string, bc: '1' | 'N' | 'M') => {
    const rid = 'r_' + label.replace(/\W/g, '');
    doc.relationships.push({ id: rid, name: label, x: 0, y: 0, kind: 'strong' });
    doc.legs.push({ id: rid + 'a', fromId: rid, toId: 'e_' + a, cardinality: ac, participation: { min: 0, max: ac === '1' ? 1 : 'N' } });
    doc.legs.push({ id: rid + 'b', fromId: rid, toId: 'e_' + b, cardinality: bc, participation: { min: 0, max: bc === '1' ? 1 : 'N' } });
  };
  rel('places', 'Customer', '1', 'Order', 'N');
  rel('contains', 'Order', '1', 'LineItem', 'N');
  rel('refers', 'LineItem', 'N', 'Product', '1');
  rel('writes', 'Customer', '1', 'Review', 'N');
  rel('about', 'Product', '1', 'Review', 'N');
  rel('works in', 'Employee', 'N', 'Department', '1');
  rel('delivers', 'Order', '1', 'Shipment', 'N');
  rel('lives at', 'Customer', '1', 'Address', 'N');
  rel('views', 'Customer', 'M', 'Product', 'N');
  // One attribute hanging off a relationship, as Chen allows.
  doc.attributes.push({ id: 'a_rel_placed', name: 'discount_pct', x: 0, y: 0, kind: 'simple', ownerId: 'r_places' });
  return doc;
}

async function shot(svg: string, file: string, scale = 2) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: scale });
  await page.setContent(`<body style="margin:0">${svg}</body>`);
  await page.screenshot({ path: file, fullPage: true });
  await browser.close();
}

function crowLab(doc: ErdDocument) {
  const placed = applyLayout(doc);
  const tables = deriveTables(placed);
  const boxes: Box[] = tables.map(t => ({ id: t.entityId, label: t.name, x: t.x, y: t.y, w: t.width,
    h: tableHeight(t), dashed: t.weak, lines: t.rows.map(r => r.name) }));
  const byId = new Map(tables.map(t => [t.entityId, t]));
  const edges: Edge[] = deriveLinks(placed).map(l => {
    const from = byId.get(l.fromEntityId)!, to = byId.get(l.toEntityId)!;
    const route = routeColumns(from, l.fromColumnId, to, l.toColumnId, l.lane, [], l.route, l.bend, l.routePoints);
    return { fromId: l.fromEntityId, toId: l.toEntityId, label: l.label, pts: route.points };
  });
  return { boxes, edges, measure: measure(boxes, edges) };
}

function chenLab(doc: ErdDocument) {
  const placed = applyLayout(doc);
  const node = (id: string) => (placed.entities.find(e => e.id === id) ?? placed.relationships.find(r => r.id === id)
    ?? placed.attributes.find(a => a.id === id) ?? { x: 0, y: 0 }) as { x: number; y: number };
  const size = (id: string) => sizeFor(placed, id);
  const boxes: Box[] = [
    ...placed.entities.map(e => { const s = size(e.id); return { id: e.id, label: e.name, x: e.x, y: e.y, w: s.w, h: s.h }; }),
    ...placed.relationships.map(r => { const s = size(r.id); return { id: r.id, label: r.name, x: r.x, y: r.y, w: s.w, h: s.h }; }),
    ...placed.attributes.map(a => { const s = size(a.id); return { id: a.id, label: a.name, x: a.x, y: a.y, w: s.w, h: s.h }; }),
  ];
  const center = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  const legs: Edge[] = placed.legs.map(l => ({ fromId: l.fromId, toId: l.toId,
    pts: [center(boxes.find(b => b.id === l.fromId)!), center(boxes.find(b => b.id === l.toId)!)] }));
  const attrEdges: Edge[] = placed.attributes
    .filter(a => a.ownerId && boxes.some(b => b.id === a.ownerId))
    .map(a => ({ fromId: a.ownerId!, toId: a.id, pts: [center(boxes.find(b => b.id === a.ownerId)!), center(boxes.find(b => b.id === a.id)!)] }));
  const edges = [...legs, ...attrEdges];
  return { boxes, edges, measure: measure(boxes, edges) };
}

test('auto-arrange lab', async () => {
  mkdirSync('output/lab', { recursive: true });
  const crow = crowLab(crowDoc());
  const nearest = (bs: Box[]) => {
    let best: any[] = [];
    for (let i=0;i<bs.length;i++) for (let j=i+1;j<bs.length;j++) {
      const a=bs[i]!, b=bs[j]!;
      const dx = Math.max(0, Math.max(a.x-(b.x+b.w), b.x-(a.x+a.w)));
      const dy = Math.max(0, Math.max(a.y-(b.y+b.h), b.y-(a.y+a.h)));
      if (dx === 0 && dy === 0) continue;
      best.push({ d: Math.hypot(dx,dy), dx, dy, a: a.id, b: b.id });
    }
    best.sort((x,y)=>x.d-y.d);
    return best.slice(0,6);
  };
  console.log('CROW', JSON.stringify(crow.measure), 'cols?', (crow.boxes.length));
  console.log('CROWNEAR', JSON.stringify(nearest(crow.boxes)));
  await shot(renderSvg(crow.boxes, crow.edges), 'output/lab/crow.png');
  const chen = chenLab(chenDoc());
  console.log('CHEN', JSON.stringify(chen.measure));
  console.log('CHENNEAR', JSON.stringify(nearest(chen.boxes)));
  await shot(renderSvg(chen.boxes, chen.edges), 'output/lab/chen.png');
  expect(crow.measure.overlaps).toBe(0);
});

