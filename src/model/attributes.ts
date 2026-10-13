import type { Attribute, ErdDocument } from './types';
import { toSqlName } from './columnNames';

/** All parts carried by an owner, independent of snapshot ordering. */
export function descendantAttributeIds(doc: ErdDocument, ownerId: string): Set<string> {
  const found = new Set<string>([ownerId]);
  for (const id of found) {
    for (const attr of doc.attributes) if (attr.ownerId === id) found.add(attr.id);
  }
  found.delete(ownerId);
  return found;
}

export function canOwnAttribute(doc: ErdDocument, attributeId: string, ownerId: string | null): boolean {
  if (!ownerId) return true;
  if (ownerId === attributeId) return false;
  if ([...doc.entities, ...doc.relationships, ...doc.isas].some(n => n.id === ownerId)) return true;
  const owner = doc.attributes.find(a => a.id === ownerId);
  return owner?.kind === 'composite' && !descendantAttributeIds(doc, attributeId).has(ownerId);
}

/** Detach invalid owners and every member of a cycle; retain valid child edges. */
export function normalizeAttributeOwners(doc: ErdDocument): Attribute[] {
  const roots = new Set([...doc.entities, ...doc.relationships, ...doc.isas].map(n => n.id));
  const byId = new Map(doc.attributes.map(a => [a.id, a]));
  const invalid = new Set<string>();
  for (const attr of doc.attributes) {
    if (attr.ownerId && !roots.has(attr.ownerId) && byId.get(attr.ownerId)?.kind !== 'composite') invalid.add(attr.id);
    const chain: string[] = [];
    let current: Attribute | undefined = attr;
    while (current) {
      const loop = chain.indexOf(current.id);
      if (loop !== -1) { for (const id of chain.slice(loop)) invalid.add(id); break; }
      chain.push(current.id);
      current = current.ownerId ? byId.get(current.ownerId) : undefined;
    }
  }
  return doc.attributes.map(a => invalid.has(a.id) ? { ...a, ownerId: null } : a);
}

/** Scalar columns with the source leaf's identity, kind and chosen data type. */
export function leafAttributesOf(doc: ErdDocument, ownerId: string): Array<Attribute & { sourceName?: string }> {
  const result: Array<Attribute & { sourceName?: string }> = [];
  const visited = new Set<string>();
  const visit = (id: string, prefix: string[]) => {
    for (const attr of doc.attributes.filter(a => a.ownerId === id)) {
      if (visited.has(attr.id) || attr.kind === 'derived') continue;
      visited.add(attr.id);
      const path = [...prefix, toSqlName(attr.name)];
      if (attr.kind === 'composite' && doc.attributes.some(a => a.ownerId === attr.id)) visit(attr.id, path);
      else result.push(prefix.length ? { ...attr, name: path.join('_'), sourceName: attr.name } : attr);
    }
  };
  visit(ownerId, []);
  return result;
}
