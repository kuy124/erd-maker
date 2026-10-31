import { emptyDocument, type ErdDocument } from '../src/model/types';

/** The realistic seventeen-entity commerce schema used for visual checks. */
export function buildShop(): ErdDocument {
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
