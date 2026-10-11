/**
 * The ERD document model.
 *
 * This is the single source of truth that both the Chen renderer and the
 * crow's-foot renderer read from. Nothing here knows about Yjs, React, or SVG:
 * it is plain data plus pure functions, so it can be unit tested in isolation
 * and reused by the SQL generator, the exporters, and the layout engine.
 *
 * A relationship leg's cardinality describes its connected entity, regardless
 * of whether that entity is stored in `fromId` or `toId`:
 *
 *   Customer --(1)---<buys>---(N)-- Order
 *   one customer places many orders
 *
 * Both renderers read these same constraints. Chen keeps the relationship
 * diamond and draws ERDPlus-style endpoint symbols beside the entity.
 */

export type EntityKind = 'strong' | 'weak';
export type RelationshipKind = 'strong' | 'weak';
export type AttributeKind = 'simple' | 'key' | 'multivalued' | 'derived' | 'composite';
export type Cardinality = '1' | 'N' | 'M';

/** Participation constraint; advanced numeric ranges are written (min,max). */
export interface Participation {
  min: number;
  /** `'N'` is written for unbounded, which keeps (1,N) and (0,N) legible. */
  max: number | 'N';
}

export interface Entity {
  id: string;
  name: string;
  x: number;
  y: number;
  kind: EntityKind;
}

export interface Attribute {
  id: string;
  name: string;
  x: number;
  y: number;
  kind: AttributeKind;
  /** The entity or relationship this attribute hangs off, or null while floating. */
  ownerId: string | null;
}

export interface Relationship {
  id: string;
  name: string;
  x: number;
  y: number;
  kind: RelationshipKind;
}

export interface Isa {
  id: string;
  x: number;
  y: number;
  /** Superclass entity. */
  parentId: string | null;
  /** Subclass entities. */
  childIds: string[];
}

export interface Leg {
  id: string;
  fromId: string;
  toId: string;
  cardinality: Cardinality;
  /** Participation of the connected entity, or the source for a legacy concept line. */
  participation: Participation;
}

export type NodeId = string;

export interface ErdDocument {
  name: string;
  view: 'chen' | 'crowfoot';
  entities: Entity[];
  attributes: Attribute[];
  relationships: Relationship[];
  isas: Isa[];
  legs: Leg[];
}

export function emptyDocument(name = 'Untitled diagram'): ErdDocument {
  return {
    name,
    view: 'chen',
    entities: [],
    attributes: [],
    relationships: [],
    isas: [],
    legs: [],
  };
}

/** Every node kind that can appear on the canvas. */
export type NodeKind = 'entity' | 'attribute' | 'relationship' | 'isa';

export interface Positioned {
  id: string;
  x: number;
  y: number;
}

/** Flat list of all positioned nodes, for layout and bounds calculations. */
export function allNodes(doc: ErdDocument): Positioned[] {
  return [...doc.entities, ...doc.attributes, ...doc.relationships, ...doc.isas];
}

export function findNode(doc: ErdDocument, id: NodeId): Positioned | undefined {
  return allNodes(doc).find((n) => n.id === id);
}

export function nodeKind(doc: ErdDocument, id: NodeId): NodeKind | undefined {
  if (doc.entities.some((e) => e.id === id)) return 'entity';
  if (doc.attributes.some((a) => a.id === id)) return 'attribute';
  if (doc.relationships.some((r) => r.id === id)) return 'relationship';
  if (doc.isas.some((i) => i.id === id)) return 'isa';
  return undefined;
}

/**
 * Nominal size of a node, used for hit-testing, connector trimming, and
 * layout. Kept in the model rather than the renderer so the two stay in sync.
 */
export const NODE_SIZE: Record<NodeKind, { w: number; h: number }> = {
  entity: { w: 150, h: 60 },
  attribute: { w: 130, h: 52 },
  relationship: { w: 150, h: 72 },
  isa: { w: 96, h: 56 },
};

export function sizeOf(doc: ErdDocument, id: NodeId): { w: number; h: number } {
  const kind = nodeKind(doc, id);
  return kind ? NODE_SIZE[kind] : { w: 0, h: 0 };
}

/**
 * A leg is only meaningful between nodes that exist and are not the same node.
 * Enforced in one place so the UI, SQL generator, and renderers agree.
 */
export function isValidLeg(doc: ErdDocument, leg: Leg): boolean {
  if (leg.fromId === leg.toId) return false;
  return Boolean(findNode(doc, leg.fromId) && findNode(doc, leg.toId));
}

/** Legs attached to a node, in either direction. */
export function legsFor(doc: ErdDocument, id: NodeId): Leg[] {
  return doc.legs.filter((l) => l.fromId === id || l.toId === id);
}

/** Attributes hanging off a node. */
export function attributesOf(doc: ErdDocument, ownerId: NodeId): Attribute[] {
  return doc.attributes.filter((a) => a.ownerId === ownerId);
}

/**
 * Removes a node and everything that only existed because of it: its legs, its
 * attributes, and any ISA links pointing at it. Returns a new document; the
 * input is not mutated.
 */
export function removeNode(doc: ErdDocument, id: NodeId): ErdDocument {
  const orphanedAttributes = new Set(
    doc.attributes.filter((a) => a.ownerId === id).map((a) => a.id),
  );
  return {
    ...doc,
    entities: doc.entities.filter((e) => e.id !== id),
    attributes: doc.attributes.filter((a) => a.id !== id && !orphanedAttributes.has(a.id)),
    relationships: doc.relationships.filter((r) => r.id !== id),
    isas: doc.isas
      .filter((i) => i.id !== id)
      .map((i) => ({
        ...i,
        parentId: i.parentId === id ? null : i.parentId,
        childIds: i.childIds.filter((c) => c !== id),
      })),
    legs: doc.legs.filter((l) => l.fromId !== id && l.toId !== id),
  };
}
