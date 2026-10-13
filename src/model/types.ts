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

import type { DataType } from './dataTypes';
import { descendantAttributeIds } from './attributes';
import type { RoutePoint } from './connectorRouting';

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
  /** Position in Chen. Shared with collaborators, and used by nothing else. */
  x: number;
  y: number;
  /**
   * Position in Crow's-foot, stored separately and shared separately.
   *
   * Arranging one notation must not rearrange the other, so this cannot be `x`
   * and `y`. It is shared like everything else: two people reading one schema
   * are looking at the same tables, and a table that slid away under a
   * collaborator's cursor is the thing this separates *from* the Chen layout,
   * not from each other.
   *
   * Absent until this browser has placed the table, at which point the Crow's-foot
   * view arranges it from the schema rather than inheriting Chen's coordinates.
   */
  crowX?: number;
  crowY?: number;
  kind: EntityKind;
}

export interface Attribute {
  id: string;
  name: string;
  x: number;
  y: number;
  kind: AttributeKind;
  /** Entity, relationship, specialization or composite attribute; null while floating. */
  ownerId: string | null;
  /** Absent means infer from the name. Foreign keys inherit the referenced type. */
  dataType?: DataType;
}

/**
 * Which way a Crow's-foot connector runs when it cannot go straight.
 *
 * Automatic picks the shorter side, which is usually right and is sometimes not:
 * two tables side by side still send a line out of the drawing when a third is
 * in the way. `above` and `below` are the override a person reaches for when the
 * automatic answer lands somewhere they did not want it.
 */
export type RouteSide = 'auto' | 'above' | 'below';

/** The accepted route preferences, for validating a value from anywhere. */
export const ROUTE_SIDES: RouteSide[] = ['auto', 'above', 'below'];

export interface Relationship {
  id: string;
  name: string;
  x: number;
  y: number;
  kind: RelationshipKind;
  /** Crow's-foot only. Absent is the same as automatic. */
  route?: RouteSide;
  /**
   * A corner the person dragged, in drawing coordinates.
   *
   * Stored flat rather than as an object because every shared field here is a
   * primitive; Yjs stores one value per key. Set it and the connector passes
   * through exactly that point, whatever the router would have chosen — an
   * automatic guess is overridable, a dragged point is a decision. Both halves
   * absent means the router still decides.
   */
  bendX?: number;
  bendY?: number;
  /** Interior vertices chosen by dragging individual crow's-foot segments. */
  routePoints?: RoutePoint[];
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
  /** Stable table-row ID for this entity's endpoint. Absent means automatic. */
  columnId?: string;
}

/**
 * A named set of shapes that move together.
 *
 * Deliberately visual. A group carries no meaning the SQL generator, the
 * crow's-foot inference, or the relationship logic can see: it is a way of
 * keeping a part of a diagram together while working on it, and it never
 * reaches an export. Making it semantic would mean deciding how a group of
 * entities becomes tables, which is a modelling question this editor should not
 * answer on the user's behalf.
 *
 * Only the membership is stored. The frame is derived from the members' bounds
 * on every render, so it cannot drift away from what it contains.
 */
export interface Group {
  id: string;
  name: string;
  /** Shapes carried by this group. Empty groups are pruned on write. */
  memberIds: string[];
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
  groups: Group[];
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
    groups: [],
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
 * The frame a group occupies, derived from its members.
 *
 * Nothing is stored, so the frame cannot disagree with what it contains: move a
 * member and the frame follows on the next render. Returns null when the group
 * has no live members, which is what a pruned group looks like.
 */
export function groupFrame(doc: ErdDocument, group: Group): Bounds | null {
  const members = group.memberIds
    .map((id) => ({ node: findNode(doc, id), size: sizeOf(doc, id) }))
    .filter((entry) => entry.node && entry.size.w > 0);
  if (members.length < 2) return null;
  const padding = 18;
  return {
    minX: Math.min(...members.map((m) => m.node!.x - padding)),
    minY: Math.min(...members.map((m) => m.node!.y - padding)),
    maxX: Math.max(...members.map((m) => m.node!.x + m.size.w + padding)),
    maxY: Math.max(...members.map((m) => m.node!.y + m.size.h + padding)),
  };
}

/**
 * Drops members that no longer exist, and groups left with fewer than two.
 *
 * A group of one is not a group: the frame would sit around a single shape
 * saying nothing, and it would survive a reload as a mystery box. Called after
 * every removal so deleting a shape cannot leave an empty frame behind.
 */
export function pruneGroups(doc: ErdDocument): ErdDocument {
  if (doc.groups.length === 0) return doc;
  const live = new Set(allNodes(doc).map((n) => n.id));
  const groups = doc.groups
    .map((group) => ({ ...group, memberIds: group.memberIds.filter((id) => live.has(id)) }))
    .filter((group) => group.memberIds.length > 1);
  return groups.length === doc.groups.length ? doc : { ...doc, groups };
}

/**
 * Removes a node and everything that only existed because of it: its legs, its
 * attributes, and any ISA links pointing at it. Returns a new document; the
 * input is not mutated.
 */
export function removeNode(doc: ErdDocument, id: NodeId): ErdDocument {
  const orphanedAttributes = descendantAttributeIds(doc, id);
  return pruneGroups({
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
    legs: doc.legs.filter((l) => l.fromId !== id && l.toId !== id &&
      !orphanedAttributes.has(l.fromId) && !orphanedAttributes.has(l.toId)),
  });
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
