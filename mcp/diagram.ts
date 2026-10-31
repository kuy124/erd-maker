/**
 * The ERD Maker MCP's diagram service.
 *
 * Everything here is built on `src/model`, the same pure model the app renders
 * and exports. Nothing re-implements the schema: a diagram written by the MCP is
 * the JSON the app imports, validation is the app's own check, and SQL is the
 * app's exporter. That is what keeps an AI-authored diagram from being a
 * plausible lookalike that the app cannot open.
 *
 * The service is stateful because an MCP session is: one working diagram is
 * opened or created, then edited by successive tool calls. Files stay inside the
 * workspace root so a model-generated path cannot write anywhere on the machine.
 */

import { constants, type Dirent } from 'node:fs';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attributeType, normalizeDataType } from '../src/model/dataTypes';
import { descendantAttributeIds, leafAttributesOf } from '../src/model/attributes';
import { toSqlName } from '../src/model/columnNames';
import {
  CROW_HEADER_HEIGHT,
  CROW_ROW_HEIGHT,
  CROW_WIDTH,
  deriveTables,
  tableHeight,
} from '../src/model/crowfoot';
import { getDiagramIssues, validParticipation, type DiagramIssue } from '../src/model/issues';
import { applyLayout } from '../src/model/layout';
import { findAttributeSlot, findFreeSlot, findRelationshipSlot, occupiedBoxes, type Box } from '../src/model/placement';
import { buildShareUrl, newRoomId, normalizeDocument } from '../src/model/snapshot';
import { describeSqlReadiness, generateSql } from '../src/model/sql';
import {
  ENTITY_KINDS,
  NODE_SIZE,
  emptyDocument,
  removeNode,
  type Attribute,
  type AttributeKind,
  type Cardinality,
  type Entity,
  type EntityKind,
  type ErdDocument,
  type Isa,
  type Leg,
  type Participation,
  type Relationship,
  type RelationshipKind,
} from '../src/model/types';
import { LiveRoom, roomFromLink, writeDocumentDiff, type CursorPoint } from './live';

/** Injected by mcp/build.mjs; absent when running from source. */
declare const __ERD_BUNDLED__: boolean | undefined;

function repositoryRoot(): string {
  // A single-file bundle has no checkout around it, so the workspace is wherever
  // it was started from; ERD_MCP_ROOT still overrides that below.
  if (typeof __ERD_BUNDLED__ !== 'undefined' && __ERD_BUNDLED__) return process.cwd();
  // A test runner serves this module from a virtual http URL, which cannot be
  // turned into a path; the process working directory is the checkout there.
  try {
    return resolve(fileURLToPath(new URL('..', import.meta.url)));
  } catch {
    return process.cwd();
  }
}

const REPO_ROOT = repositoryRoot();
/** Files the MCP reads and writes must stay under this directory. */
export const WORKSPACE_ROOT = resolve(process.env.ERD_MCP_ROOT ?? REPO_ROOT);

/** Where diagrams are created when a tool call does not name a path. */
export const DIAGRAMS_ROOT = resolve(WORKSPACE_ROOT, process.env.ERD_MCP_DIR ?? 'diagrams');

export type DiagramView = ErdDocument['view'];

export interface AttributeSpec {
  name: string;
  kind?: AttributeKind;
  dataType?: string;
  attributes?: AttributeSpec[];
}

export interface EntitySpec {
  name: string;
  kind?: EntityKind;
  attributes?: AttributeSpec[];
  /** Top-left in the view being created. Omit to take the first free slot. */
  x?: number;
  y?: number;
}

export interface ParticipationSpec {
  min: number;
  max: number | 'N';
}

export interface RelationshipSpec {
  name: string;
  kind?: RelationshipKind;
  /** Entity name or id at this end. */
  from: string;
  /** Entity name or id at the far end. */
  to: string;
  /**
   * `from:to`, one of 1:1, 1:N, N:1, N:M, M:N. Each side describes the entity
   * at that end, so `Customer -> Order` with `1:N` means one customer places
   * many orders.
   */
  cardinality?: string;
  fromParticipation?: ParticipationSpec;
  toParticipation?: ParticipationSpec;
  /** Attributes hanging off the relationship itself, e.g. `enrolled_at`. */
  attributes?: AttributeSpec[];
}

export interface IsaSpec {
  parent: string;
  children: string[];
}

export interface CreateSpec {
  name: string;
  view?: DiagramView;
  entities: EntitySpec[];
  relationships?: RelationshipSpec[];
  isas?: IsaSpec[];
  /** Workspace-relative JSON path. Omit to get `diagrams/<slug>.json`. */
  path?: string;
  /** Replace an explicitly named file that already exists. */
  overwrite?: boolean;
  /** Run the app's whole-diagram layout instead of keeping the supplied positions. False keeps free-slot placement. */
  layout?: boolean;
  /** Set false to keep the diagram in this session without writing a file. */
  save?: boolean;
}

export interface SummaryAttribute {
  id: string;
  name: string;
  kind: AttributeKind;
  type: string;
}

export interface SummaryColumn {
  name: string;
  type: string;
  pk: boolean;
  fk: boolean;
  unique?: boolean;
  references?: string;
}

export interface SummaryRelationshipEnd {
  entityId: string;
  entityName: string;
  cardinality: Cardinality;
  participation: Participation;
  columnId?: string;
}

export interface DiagramSummary {
  name: string;
  view: DiagramView;
  filePath: string | null;
  counts: {
    entities: number;
    attributes: number;
    relationships: number;
    specializations: number;
  };
  entities: Array<{
    id: string;
    name: string;
    kind: EntityKind;
    /** Top-left of the entity in the current view; a table's top-left in crow's-foot. */
    position: { x: number; y: number };
    attributes: SummaryAttribute[];
    columns: SummaryColumn[];
  }>;
  relationships: Array<{
    id: string;
    name: string;
    kind: RelationshipKind;
    ends: SummaryRelationshipEnd[];
    attributes: SummaryAttribute[];
  }>;
  specializations: Array<{ id: string; parent: string | null; children: string[] }>;
  issues: Array<DiagramIssue & { nodeName: string | null }>;
  sqlReadiness: string;
}

export interface LiveInfo {
  room: string;
  relay: string;
  watching: number;
  peers: string[];
}

export interface ShareInfo {
  room: string;
  url: string;
  hash: string;
  live?: LiveInfo;
}

export interface MutationResult {
  message: string;
  nodeId?: string;
  /** Where the shape was placed, for the current view. */
  position?: { x: number; y: number };
  filePath: string | null;
  savedTo?: string;
  saveError?: string;
  live?: LiveInfo;
  issues: Array<DiagramIssue & { nodeName: string | null }>;
}

interface Session {
  doc: ErdDocument;
  filePath: string | null;
  dirty: boolean;
  live: LiveRoom | null;
  /** Where the live room's app is served, when a share link said so. */
  liveBaseUrl?: string;
}

let session: Session | null = null;

/**
 * Where the pointer stood the last time the assistant left a room.
 *
 * Kept outside the session because a session is replaced by every create and
 * open, while the pointer is one continuous hand: rejoining should start it
 * moving from where it stopped, not snap it onto the first shape.
 */
let lastPointer: CursorPoint | null = null;

function liveInfo(live: LiveRoom | null): LiveInfo | null {
  return live
    ? { room: live.room, relay: live.relayUrl, watching: live.watching, peers: live.peers.map((peer) => peer.name) }
    : null;
}

/** The live room is the source of truth while it is open. */
function refreshSession(current: Session): void {
  if (current.live) current.doc = current.live.snapshot();
}

/** The open diagram, or null when the session has not opened one yet. */
export function peekSession(): {
  doc: ErdDocument;
  filePath: string | null;
  dirty: boolean;
  live: LiveInfo | null;
} | null {
  if (!session) return null;
  refreshSession(session);
  return { doc: session.doc, filePath: session.filePath, dirty: session.dirty, live: liveInfo(session.live) };
}

function requireSession(): Session {
  if (!session) {
    throw new Error('No diagram is open. Call create_diagram or open_diagram first.');
  }
  refreshSession(session);
  return session;
}

/** Keeps a model-supplied path inside the workspace. */
export function resolveDiagramPath(input: string): string {
  if (!input.trim()) throw new Error('Pass a diagram path.');
  const candidate = isAbsolute(input) ? resolve(input) : resolve(WORKSPACE_ROOT, input);
  const rel = relative(WORKSPACE_ROOT, candidate);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Diagram paths must stay inside ${WORKSPACE_ROOT}.`);
  }
  if (!candidate.toLowerCase().endsWith('.json')) {
    throw new Error('Diagram files must use a .json extension.');
  }
  return candidate;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function serialize(doc: ErdDocument): string {
  return JSON.stringify(doc, null, 2) + '\n';
}

async function readDocument(path: string): Promise<ErdDocument> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new Error(`Could not read ${path}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
    !Array.isArray((parsed as Record<string, unknown>).entities)) {
    throw new Error(`${path} does not contain a diagram. Export a JSON file from ERD Maker.`);
  }
  return normalizeDocument(parsed);
}

async function writeDocument(doc: ErdDocument, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serialize(doc), 'utf8');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function uniqueDefaultPath(name: string): Promise<string> {
  await mkdir(DIAGRAMS_ROOT, { recursive: true });
  const stem = toSqlName(name);
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = resolve(DIAGRAMS_ROOT, `${stem}${index === 1 ? '' : `-${index}`}.json`);
    if (!(await fileExists(candidate))) return candidate;
  }
  return resolve(DIAGRAMS_ROOT, `${stem}-${Date.now().toString(36)}.json`);
}

function requireName(value: string, label: string): string {
  const name = value.trim();
  if (!name) throw new Error(`A ${label.toLowerCase()} needs a name.`);
  return name;
}

function entityKind(value: EntityKind | undefined): EntityKind {
  if (value === undefined) return 'strong';
  if (!ENTITY_KINDS.includes(value)) throw new Error(`Entity kind must be one of ${ENTITY_KINDS.join(', ')}.`);
  return value;
}

const ATTRIBUTE_KINDS: AttributeKind[] = ['simple', 'key', 'unique', 'multivalued', 'derived', 'composite'];

function attributeKind(value: string | undefined, hasParts: boolean): AttributeKind {
  if (value === undefined) return hasParts ? 'composite' : 'simple';
  const kind = ATTRIBUTE_KINDS.find((candidate) => candidate === value);
  if (!kind) throw new Error(`Attribute kind must be one of ${ATTRIBUTE_KINDS.join(', ')}.`);
  if (hasParts && kind !== 'composite') {
    throw new Error('An attribute with parts must have kind "composite".');
  }
  return kind;
}

function relationshipKind(value: RelationshipKind | undefined, from: Entity, to: Entity): RelationshipKind {
  if (value !== undefined) {
    if (value !== 'strong' && value !== 'weak') throw new Error('Relationship kind must be "strong" or "weak".');
    return value;
  }
  return from.kind === 'weak' || to.kind === 'weak' ? 'weak' : 'strong';
}

const CARDINALITIES: Record<string, [Cardinality, Cardinality]> = {
  '1:1': ['1', '1'],
  '1:N': ['1', 'N'],
  'N:1': ['N', '1'],
  'N:M': ['N', 'M'],
  'M:N': ['M', 'N'],
};

function parseCardinality(value: string | undefined): [Cardinality, Cardinality] {
  const key = (value ?? '1:N').trim().toUpperCase();
  const cards = CARDINALITIES[key];
  if (!cards) throw new Error(`Cardinality "${value}" must be one of 1:1, 1:N, N:1, N:M, M:N.`);
  return cards;
}

/** Optional at both ends unless the caller says otherwise. */
function participationOf(spec: ParticipationSpec | undefined, card: Cardinality): Participation {
  const participation = spec ?? { min: 0, max: card === '1' ? 1 : 'N' };
  if (!validParticipation(participation.min, participation.max)) {
    throw new Error('Participation needs a whole-number minimum of 0 or more, and a maximum at least as large (or N).');
  }
  return { min: participation.min, max: participation.max };
}

function newId(prefix: string, base: string, used: Set<string>): string {
  const root = `${prefix}_${toSqlName(base)}`;
  let id = root;
  for (let suffix = 2; used.has(id); suffix += 1) id = `${root}_${suffix}`;
  used.add(id);
  return id;
}

function collectIds(doc: ErdDocument): Set<string> {
  return new Set(
    [...doc.entities, ...doc.attributes, ...doc.relationships, ...doc.isas, ...doc.legs].map((node) => node.id),
  );
}

function dataTypeOf(value: string | undefined, name: string): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const type = normalizeDataType(value);
  if (!type) {
    throw new Error(`Unknown data type "${value}" for ${name}. Use a type such as INT, VARCHAR(120), NUMERIC(10,2), DATE, TIMESTAMP, UUID, BOOLEAN, JSONB, or ENUM('a','b').`);
  }
  return type;
}

function addAttributeSpecs(
  doc: ErdDocument,
  ownerId: string,
  ownerSlug: string,
  specs: AttributeSpec[],
  used: Set<string>,
  onCreated?: (attribute: Attribute) => void,
): void {
  for (const spec of specs) {
    const name = requireName(spec.name, 'Attribute');
    const parts = spec.attributes ?? [];
    const attribute: Attribute = {
      id: newId('attr', `${ownerSlug}_${name}`, used),
      name,
      x: 0,
      y: 0,
      kind: attributeKind(spec.kind, parts.length > 0),
      ownerId,
    };
    const dataType = dataTypeOf(spec.dataType, name);
    if (dataType) attribute.dataType = dataType;
    doc.attributes.push(attribute);
    onCreated?.(attribute);
    if (parts.length) addAttributeSpecs(doc, attribute.id, `${ownerSlug}_${name}`, parts, used, onCreated);
  }
}

function entityFromMap(byName: Map<string, Entity>, ref: string): Entity {
  const entity = byName.get(ref.trim().toLowerCase());
  if (!entity) {
    const names = [...byName.values()].map((candidate) => candidate.name).join(', ');
    throw new Error(`No entity named "${ref}" in this diagram. Available entities: ${names}.`);
  }
  return entity;
}

function addRelationshipSpec(
  doc: ErdDocument,
  spec: RelationshipSpec,
  byName: Map<string, Entity>,
  used: Set<string>,
): Relationship {
  const name = requireName(spec.name, 'Relationship');
  const from = entityFromMap(byName, spec.from);
  const to = entityFromMap(byName, spec.to);
  const [fromCard, toCard] = parseCardinality(spec.cardinality);
  const relationship: Relationship = {
    id: newId('rel', name, used),
    name,
    x: 0,
    y: 0,
    kind: relationshipKind(spec.kind, from, to),
  };
  doc.relationships.push(relationship);
  addAttributeSpecs(doc, relationship.id, name, spec.attributes ?? [], used);

  const leg = (entity: Entity, card: Cardinality, part: ParticipationSpec | undefined, suffix: string): Leg => ({
    id: newId('leg', `${name}_${suffix}`, used),
    fromId: relationship.id,
    toId: entity.id,
    cardinality: card,
    participation: participationOf(part, card),
  });
  doc.legs.push(leg(from, fromCard, spec.fromParticipation, from.name));
  doc.legs.push(leg(to, toCard, spec.toParticipation, to.name));
  return relationship;
}

/** A point the caller chose, or null to let placement pick one. */
function specPoint(spec: { x?: number; y?: number }, label: string): { x: number; y: number } | null {
  if (spec.x === undefined && spec.y === undefined) return null;
  if (spec.x === undefined || spec.y === undefined || !Number.isFinite(spec.x) || !Number.isFinite(spec.y)) {
    throw new Error(`${label} needs both x and y, or neither. Omit both to take the first free slot.`);
  }
  return { x: Math.round(spec.x), y: Math.round(spec.y) };
}

interface BuiltDocument {
  doc: ErdDocument;
  /** Entities whose coordinates the caller chose. Placement leaves these alone. */
  fixed: Set<string>;
}

function buildDocument(spec: CreateSpec): BuiltDocument {
  if (!Array.isArray(spec.entities) || spec.entities.length === 0) {
    throw new Error('A diagram needs at least one entity.');
  }
  const name = requireName(spec.name, 'Diagram');
  const doc = emptyDocument(name);
  doc.view = spec.view === 'crowfoot' ? 'crowfoot' : 'chen';
  const used = new Set<string>();
  const byName = new Map<string, Entity>();
  const fixed = new Set<string>();

  for (const entitySpec of spec.entities) {
    const entityName = requireName(entitySpec.name, 'Entity');
    const key = entityName.toLowerCase();
    if (byName.has(key)) throw new Error(`Duplicate entity name "${entityName}". Use one entity per table.`);
    const point = specPoint(entitySpec, `Entity "${entityName}"`);
    const entity: Entity = {
      id: newId('ent', entityName, used),
      name: entityName,
      x: point?.x ?? 0,
      y: point?.y ?? 0,
      // In the crow's-foot view the caller's point is the table's top-left, and
      // it seeds the Chen position too so neither view starts in a pile.
      ...(point && doc.view === 'crowfoot' ? { crowX: point.x, crowY: point.y } : {}),
      kind: entityKind(entitySpec.kind),
    };
    if (point) fixed.add(entity.id);
    doc.entities.push(entity);
    byName.set(key, entity);
  }

  for (const entitySpec of spec.entities) {
    const entity = entityFromMap(byName, entitySpec.name);
    addAttributeSpecs(doc, entity.id, entity.name, entitySpec.attributes ?? [], used);
  }

  for (const relationship of spec.relationships ?? []) {
    addRelationshipSpec(doc, relationship, byName, used);
  }

  for (const isaSpec of spec.isas ?? []) {
    const parent = entityFromMap(byName, isaSpec.parent);
    if (!Array.isArray(isaSpec.children) || isaSpec.children.length === 0) {
      throw new Error(`Specialization on ${parent.name} needs at least one child.`);
    }
    const children = isaSpec.children.map((child) => entityFromMap(byName, child));
    doc.isas.push({
      id: newId('isa', parent.name, used),
      x: 0,
      y: 0,
      parentId: parent.id,
      childIds: children.map((child) => child.id),
    });
  }

  return { doc: normalizeDocument(doc), fixed };
}

/** Arranges one notation, leaving the other one's coordinates alone. */
function arrangeView(doc: ErdDocument, view: DiagramView): ErdDocument {
  return view === 'crowfoot'
    ? { ...applyLayout({ ...doc, view: 'crowfoot' }), view: 'crowfoot' }
    : { ...applyLayout({ ...doc, view: 'chen' }), view: 'chen' };
}

/** A new crow's-foot diagram also gets Chen coordinates, so switching views is not a pile-up. */
function arrangeNewDocument(doc: ErdDocument, view: DiagramView): ErdDocument {
  const chen = arrangeView(doc, 'chen');
  return view === 'crowfoot' ? arrangeView(chen, 'crowfoot') : chen;
}

/**
 * Coordinates for the shapes the caller did not place.
 *
 * This is placement, not arrangement: a coordinate the caller supplied is never
 * touched, and everything else takes the first free slot or stacks beside its
 * owner. A diagram that arrives with coordinates arrives exactly as drawn.
 * Both notations are seeded, so flipping views shows a layout instead of a pile
 * of tables at the origin.
 */
function placeNewDocument(built: BuiltDocument, view: DiagramView): ErdDocument {
  // A coordinate belongs to the notation it was written for. The other view is
  // placed freely, so a Chen column of entities does not become a pile of
  // half-overlapping tables in crow's-foot.
  placeChen(built.doc, view === 'chen' ? built.fixed : new Set());
  placeCrow(built.doc, view === 'crowfoot' ? built.fixed : new Set());
  return normalizeDocument(built.doc);
}

/** Places the Chen-only shapes: entities, diamonds, specializations, attributes. */
function placeChen(doc: ErdDocument, fixed: Set<string>): void {
  const placed = new Set(fixed);
  // A shape still sitting at its origin is not a neighbour. Counting it would
  // push every new shape away from the grid slot it belongs on.
  const placedDoc = (): ErdDocument => ({
    ...doc,
    view: 'chen',
    entities: doc.entities.filter((node) => placed.has(node.id)),
    attributes: doc.attributes.filter((node) => placed.has(node.id)),
    relationships: doc.relationships.filter((node) => placed.has(node.id)),
    isas: doc.isas.filter((node) => placed.has(node.id)),
    legs: doc.legs.filter((leg) => placed.has(leg.fromId) && placed.has(leg.toId)),
  });

  for (const entity of doc.entities) {
    if (placed.has(entity.id)) continue;
    const slot = findFreeSlot(occupiedBoxes(placedDoc()), undefined, NODE_SIZE.entity);
    entity.x = slot.x;
    entity.y = slot.y;
    placed.add(entity.id);
  }

  for (const isa of doc.isas) {
    const slot = findFreeSlot(occupiedBoxes(placedDoc()), undefined, NODE_SIZE.isa);
    isa.x = slot.x;
    isa.y = slot.y;
    placed.add(isa.id);
  }

  for (const relationship of doc.relationships) {
    const ends = doc.legs.filter((leg) => leg.fromId === relationship.id || leg.toId === relationship.id);
    const from = ends[0] ? doc.entities.find((entity) => entity.id === ends[0]!.toId) : undefined;
    const to = ends[1] ? doc.entities.find((entity) => entity.id === ends[1]!.toId) : undefined;
    const spot = from && to
      ? findRelationshipSlot(placedDoc(), from.id, to.id)
      : findFreeSlot(occupiedBoxes(placedDoc()), undefined, NODE_SIZE.relationship);
    relationship.x = spot.x;
    relationship.y = spot.y;
    placed.add(relationship.id);
  }

  for (const attribute of doc.attributes) {
    const slot = findAttributeSlot(placedDoc(), attribute.ownerId) ??
      findFreeSlot(occupiedBoxes(placedDoc()), undefined, NODE_SIZE.attribute);
    attribute.x = slot.x;
    attribute.y = slot.y;
    placed.add(attribute.id);
  }
}

/** Places crow's-foot tables, which store their own coordinates. */
function placeCrow(doc: ErdDocument, fixed: Set<string>): void {
  const heights = new Map(deriveTables(doc).map((table) => [table.entityId, tableHeight(table)]));
  const occupied: Box[] = [];
  for (const entity of doc.entities) {
    const size = { w: CROW_WIDTH, h: heights.get(entity.id) ?? CROW_HEADER_HEIGHT + CROW_ROW_HEIGHT };
    if (fixed.has(entity.id)) {
      const x = entity.crowX ?? entity.x;
      const y = entity.crowY ?? entity.y;
      entity.crowX = x;
      entity.crowY = y;
      occupied.push({ x, y, ...size });
      continue;
    }
    const slot = findFreeSlot(occupied, undefined, size);
    entity.crowX = slot.x;
    entity.crowY = slot.y;
    occupied.push({ ...slot, ...size });
  }
}

function nodeName(doc: ErdDocument, id: string): string | null {
  return doc.entities.find((node) => node.id === id)?.name ??
    doc.attributes.find((node) => node.id === id)?.name ??
    doc.relationships.find((node) => node.id === id)?.name ??
    (doc.isas.some((node) => node.id === id) ? 'specialization' : null) ??
    (doc.legs.some((node) => node.id === id) ? 'line' : null);
}

function issuesOf(doc: ErdDocument): Array<DiagramIssue & { nodeName: string | null }> {
  return getDiagramIssues(doc).map((issue) => ({ ...issue, nodeName: nodeName(doc, issue.nodeId) }));
}

export function summarizeDocument(doc: ErdDocument, filePath: string | null = null): DiagramSummary {
  const tables = deriveTables(doc);
  return {
    name: doc.name,
    view: doc.view,
    filePath,
    counts: {
      entities: doc.entities.length,
      attributes: doc.attributes.length,
      relationships: doc.relationships.length,
      specializations: doc.isas.length,
    },
    entities: doc.entities.map((entity) => {
      const table = tables.find((candidate) => candidate.entityId === entity.id);
      return {
        id: entity.id,
        name: entity.name,
        kind: entity.kind,
        position: doc.view === 'crowfoot'
          ? { x: entity.crowX ?? entity.x, y: entity.crowY ?? entity.y }
          : { x: entity.x, y: entity.y },
        attributes: leafAttributesOf(doc, entity.id).map((attribute) => ({
          id: attribute.id,
          name: attribute.name,
          kind: attribute.kind,
          type: attributeType(attribute),
        })),
        columns: (table?.rows ?? []).map((row) => ({
          name: row.name,
          type: row.type,
          pk: row.pk,
          fk: row.fk,
          ...(row.unique ? { unique: true } : {}),
          ...(row.references ? { references: row.references.label } : {}),
        })),
      };
    }),
    relationships: doc.relationships.map((relationship) => ({
      id: relationship.id,
      name: relationship.name,
      kind: relationship.kind,
      ends: doc.legs
        .filter((leg) => leg.fromId === relationship.id || leg.toId === relationship.id)
        .flatMap((leg) => {
          const entityId = leg.fromId === relationship.id ? leg.toId : leg.fromId;
          const entity = doc.entities.find((candidate) => candidate.id === entityId);
          if (!entity) return [];
          return [{
            entityId: entity.id,
            entityName: entity.name,
            cardinality: leg.cardinality,
            participation: leg.participation,
            ...(leg.columnId ? { columnId: leg.columnId } : {}),
          }];
        }),
      attributes: leafAttributesOf(doc, relationship.id).map((attribute) => ({
        id: attribute.id,
        name: attribute.name,
        kind: attribute.kind,
        type: attributeType(attribute),
      })),
    })),
    specializations: doc.isas.map((isa) => ({
      id: isa.id,
      parent: doc.entities.find((entity) => entity.id === isa.parentId)?.name ?? null,
      children: isa.childIds.map((id) => doc.entities.find((entity) => entity.id === id)?.name ?? id),
    })),
    issues: issuesOf(doc),
    sqlReadiness: describeSqlReadiness(doc),
  };
}

/** A readable outline for a model that would rather not parse the JSON summary. */
export function summaryOutline(summary: DiagramSummary): string {
  const lines: string[] = [`${summary.name} (${summary.view})`];
  lines.push(`Entities (${summary.counts.entities}):`);
  for (const entity of summary.entities) {
    const attributes = entity.attributes.map((attribute) =>
      `${attribute.name} ${attribute.kind}${attribute.type ? `:${attribute.type}` : ''}`).join(', ');
    const x = Math.round(entity.position.x);
    const y = Math.round(entity.position.y);
    lines.push(`- ${entity.name} [${entity.kind}] ${entity.id} at (${x}, ${y})${attributes ? `: ${attributes}` : ''}`);
  }
  if (summary.relationships.length) {
    lines.push(`Relationships (${summary.counts.relationships}):`);
    for (const relationship of summary.relationships) {
      const ends = relationship.ends.map((end) =>
        `${end.entityName} ${end.cardinality} (${end.participation.min}..${end.participation.max})`).join(' - ');
      lines.push(`- ${relationship.name} [${relationship.kind}] ${relationship.id}: ${ends}`);
    }
  }
  if (summary.specializations.length) {
    lines.push(`Specializations (${summary.counts.specializations}):`);
    for (const isa of summary.specializations) {
      lines.push(`- ${isa.parent ?? '(no parent)'} -> ${isa.children.join(', ')}`);
    }
  }
  if (summary.issues.length) {
    lines.push(`Warnings (${summary.issues.length}):`);
    for (const issue of summary.issues) lines.push(`- ${issue.code}: ${issue.message}`);
  } else {
    lines.push('Warnings: none.');
  }
  return lines.join('\n');
}

function shareInfo(doc: ErdDocument, options: { baseUrl?: string; room?: string; includeSnapshot?: boolean } = {}): ShareInfo {
  const current = session;
  const live = current?.live ?? null;
  const baseUrl = options.baseUrl ?? current?.liveBaseUrl ?? process.env.ERD_MCP_APP_URL ?? 'http://localhost:5173/';
  // A link to a room the AI is already in keeps the AI's edits live.
  const room = options.room?.trim() || live?.room || newRoomId();
  const includeSnapshot = options.includeSnapshot ?? true;
  const url = buildShareUrl(baseUrl, doc, room, includeSnapshot);
  const hashIndex = url.indexOf('#');
  return {
    room,
    url,
    hash: hashIndex === -1 ? '' : url.slice(hashIndex),
    ...(live ? { live: liveInfo(live)! } : {}),
  };
}

async function saveNew(doc: ErdDocument, requested: string | undefined, overwrite: boolean): Promise<string> {
  const path = requested ? resolveDiagramPath(requested) : await uniqueDefaultPath(doc.name);
  if (requested && (await fileExists(path)) && !overwrite) {
    throw new Error(`${path} already exists. Pass overwrite: true or choose another path.`);
  }
  await writeDocument(doc, path);
  return path;
}

async function persistAfterMutation(): Promise<{ savedTo?: string; saveError?: string }> {
  const current = requireSession();
  if (!current.filePath) return {};
  try {
    await writeDocument(current.doc, current.filePath);
    current.dirty = false;
    return { savedTo: current.filePath };
  } catch (error) {
    return { saveError: errorMessage(error) };
  }
}

/**
 * Publishes a finished edit.
 *
 * Edits are built on a clone, because a tool call that throws halfway through
 * (a bad data type on the third attribute, a duplicate name) must leave the open
 * diagram exactly as it was. A half-applied diagram is worse than a failed call:
 * the model is told nothing changed, and the file on disk disagrees.
 *
 * In a room with a watcher, the pointer travels to the shape first and the write
 * lands when it arrives, so a single edit reads the way a streamed diagram
 * already does — travel, click, change. Writing first made the shape jump into
 * existence and the cursor arrive afterwards, which is a teleport with an
 * explanation. Nobody watching means nobody to perform for, so the edit stays
 * instant.
 */
async function commit(current: Session, doc: ErdDocument, focusId?: string | null): Promise<void> {
  const next = normalizeDocument(doc);
  if (!current.live) {
    current.doc = next;
    current.dirty = true;
    return;
  }
  const live = current.live;
  const watched = focusId !== null && Boolean(focusId) && live.watching > 0;
  if (watched) await live.glideTo(next, focusId ?? null, false);
  const changed = writeDocumentDiff(live.ydoc, current.doc, next);
  // The landing is the click: it is published with the change, not before it.
  live.flash(next, focusId ?? changed[0] ?? null, focusId !== null && focusId !== undefined);
  current.doc = live.snapshot();
  current.dirty = true;
}

/**
 * Publishes an edit that moved a shape, as a carry rather than a click.
 *
 * The shape stays under the pointer for the whole travel and only settles where
 * it is released, so a watcher sees the same gesture they produce by dragging
 * it themselves. A move that appeared where it landed, with the cursor arriving
 * afterwards, read as the diagram deciding on its own.
 */
async function commitDrag(current: Session, doc: ErdDocument, focusId: string): Promise<void> {
  const next = normalizeDocument(doc);
  if (!current.live) {
    current.doc = next;
    current.dirty = true;
    return;
  }
  const live = current.live;
  // Nobody watching means nobody to perform for: the move stays instant.
  const carried = live.watching > 0 ? await live.dragTo(current.doc, next, focusId) : false;
  writeDocumentDiff(live.ydoc, current.doc, next);
  if (carried) live.release(next, focusId);
  current.doc = live.snapshot();
  current.dirty = true;
}

/**
 * Publishes an edit that takes several shapes, with a loop drawn around them.
 *
 * Removing a table also removes its columns, so the loop names what is about to
 * go before it goes. A single shape keeps the ordinary click: a loop around one
 * box is ceremony without a payload.
 */
async function commitLasso(current: Session, doc: ErdDocument, ids: string[]): Promise<void> {
  if (ids.length < 2) {
    await commit(current, doc, ids[0] ?? null);
    return;
  }
  const next = normalizeDocument(doc);
  if (!current.live) {
    current.doc = next;
    current.dirty = true;
    return;
  }
  const live = current.live;
  const watched = live.watching > 0;
  if (watched) await live.lasso(current.doc, ids);
  writeDocumentDiff(live.ydoc, current.doc, next);
  if (watched) live.release(next, null);
  current.doc = live.snapshot();
  current.dirty = true;
}

/**
 * Leaves the thinking ring over the last shape while a read-only answer is
 * worked out. Nobody watching means nobody to show it to, so it stays silent.
 */
function thinkIn(current: Session): void {
  if (current.live && current.live.watching > 0) current.live.think();
}

/** Where a shape sits in the notation currently shown, when that notation has a place for it. */
function activePosition(doc: ErdDocument, id: string): { x: number; y: number } | undefined {
  const entity = doc.entities.find((candidate) => candidate.id === id);
  if (entity) {
    return doc.view === 'crowfoot'
      ? { x: entity.crowX ?? entity.x, y: entity.crowY ?? entity.y }
      : { x: entity.x, y: entity.y };
  }
  if (doc.view === 'crowfoot') return undefined;
  const node = [...doc.attributes, ...doc.relationships, ...doc.isas]
    .find((candidate) => candidate.id === id);
  return node ? { x: node.x, y: node.y } : undefined;
}

function mutation(doc: ErdDocument, message: string, nodeId?: string): MutationResult {
  const current = requireSession();
  const position = nodeId ? activePosition(doc, nodeId) : undefined;
  return {
    message,
    ...(nodeId ? { nodeId } : {}),
    ...(position ? { position } : {}),
    filePath: current.filePath,
    ...(current.live ? { live: liveInfo(current.live)! } : {}),
    issues: issuesOf(doc),
  };
}

export async function createDiagram(spec: CreateSpec): Promise<{
  filePath: string | null;
  summary: DiagramSummary;
  outline: string;
  share: ShareInfo;
}> {
  const previous = session;
  const built = buildDocument(spec);
  // A diagram that says where its shapes go opens exactly where it was drawn.
  // One that arrives with no coordinates at all is arranged by the app's own
  // layout engine instead of taking free slots on a grid: the grid parks each
  // shape beside its owner without ever looking at the diagram as a whole,
  // which is not a layout a person would accept.
  const authored = built.fixed.size > 0;
  let doc = spec.layout === true || (spec.layout !== false && !authored)
    ? arrangeNewDocument(built.doc, built.doc.view)
    : placeNewDocument(built, built.doc.view);
  const filePath = spec.save === false ? null : await saveNew(doc, spec.path, spec.overwrite ?? false);
  if (previous?.live) {
    // Someone is watching: replace the room shape by shape and keep the file in
    // step with what the room actually ended up containing.
    await previous.live.replace(doc, previous.live.watching > 0);
    doc = previous.live.snapshot();
    if (filePath) await writeDocument(doc, filePath);
    session = { doc, filePath, dirty: false, live: previous.live, liveBaseUrl: previous.liveBaseUrl };
  } else {
    session = { doc, filePath, dirty: false, live: null };
  }
  const summary = summarizeDocument(doc, filePath);
  return { filePath, summary, outline: summaryOutline(summary), share: shareInfo(doc) };
}

export async function openDiagram(path: string, view?: DiagramView): Promise<{
  filePath: string;
  summary: DiagramSummary;
  outline: string;
}> {
  const filePath = resolveDiagramPath(path);
  const doc = await readDocument(filePath);
  if (view) doc.view = view;
  session?.live?.close();
  session = { doc, filePath, dirty: false, live: null };
  const summary = summarizeDocument(doc, filePath);
  return { filePath, summary, outline: summaryOutline(summary) };
}

export interface OpenRoomOptions {
  /** Share link, share fragment, or room id. Omit to start a new room. */
  link?: string;
  /** App URL used for the returned share link. */
  baseUrl?: string;
  /** Copy the open diagram into an empty room. Defaults to true. */
  seed?: boolean;
}

export interface OpenRoomResult {
  room: string;
  url: string;
  relay: string;
  watching: number;
  peers: string[];
  seeded: boolean;
  summary: DiagramSummary;
  outline: string;
}

export async function openRoom(options: OpenRoomOptions = {}): Promise<OpenRoomResult> {
  const linkText = (options.link ?? '').trim();
  const link = roomFromLink(linkText);
  if (linkText && !link.room && !link.baseUrl) {
    throw new Error('That is not a room id or share link. Paste a link like https://kuy124.github.io/erd-maker/#room=... or an 8+ character room id.');
  }
  const current = session;
  const room = link.room ?? (link.baseUrl ? newRoomId() : current?.live?.room ?? newRoomId());

  if (current?.live?.room === room) {
    const summary = summarizeDocument(current.doc, current.filePath);
    return {
      room,
      url: shareInfo(current.doc).url,
      relay: current.live.relayUrl,
      watching: current.live.watching,
      peers: current.live.peers.map((peer) => peer.name),
      seeded: false,
      summary,
      outline: summaryOutline(summary),
    };
  }

  // A room that already has content wins; seeding only fills an empty one.
  const seed = link.doc ?? (options.seed === false ? undefined : current?.doc);
  const next = await LiveRoom.join({
    room,
    ...(seed ? { seed } : {}),
    ...(lastPointer ? { startCursor: lastPointer } : {}),
  });

  current?.live?.close();
  const fileBelongs = Boolean(current?.filePath && next.seeded && seed === current.doc);
  session = {
    doc: next.snapshot(),
    filePath: fileBelongs ? current!.filePath : null,
    dirty: false,
    live: next,
    liveBaseUrl: options.baseUrl ?? link.baseUrl ?? current?.liveBaseUrl,
  };
  // Arrive at a real shape rather than with no cursor at all: the watcher should
  // see the assistant come into the room and stop, not find an avatar that was
  // always there.
  const focus = session.doc.entities[0]?.id ?? session.doc.relationships[0]?.id ?? session.doc.isas[0]?.id ?? null;
  next.enter(session.doc, focus);
  const summary = summarizeDocument(session.doc, session.filePath);
  return {
    room,
    url: shareInfo(session.doc, { baseUrl: session.liveBaseUrl }).url,
    relay: next.relayUrl,
    watching: next.watching,
    peers: next.peers.map((peer) => peer.name),
    seeded: next.seeded,
    summary,
    outline: summaryOutline(summary),
  };
}

export interface LeaveRoomResult {
  room: string | null;
  message: string;
}

/**
 * Signs the assistant out of the live room it is editing.
 *
 * Nothing else disconnected it, so a watcher was left with an avatar that had
 * stopped moving and no way to tell finished work from a stall. This gives the
 * room a goodbye it can see, then keeps the diagram open locally: leaving is not
 * undoing.
 */
export async function leaveRoom(): Promise<LeaveRoomResult> {
  const current = session;
  const live = current?.live;
  if (!current || !live) {
    return { room: null, message: 'This diagram is not in a live room, so there is nothing to leave.' };
  }
  const room = live.room;
  lastPointer = live.pointer;
  await live.leave(current.doc);
  session = { ...current, live: null };
  return {
    room,
    message: `Left room ${room}. The diagram stays open here, so edits keep working — they just no longer stream to watchers.`,
  };
}

export async function saveDiagram(path?: string, overwrite = false): Promise<string> {
  const current = requireSession();
  const target = path ? resolveDiagramPath(path) : current.filePath;
  if (!target) throw new Error('This diagram has no file yet. Pass a path to save it.');
  // Saving back to the open file is the whole point of this call; replacing some
  // other diagram with it is a mistake unless the caller says so.
  if (path && target !== current.filePath && !overwrite && (await fileExists(target))) {
    throw new Error(`${target} already exists. Pass overwrite: true to replace it.`);
  }
  await writeDocument(current.doc, target);
  current.filePath = target;
  current.dirty = false;
  return target;
}

export function getDiagram(): {
  filePath: string | null;
  dirty: boolean;
  live: LiveInfo | null;
  document: ErdDocument;
} {
  const current = requireSession();
  return { filePath: current.filePath, dirty: current.dirty, live: liveInfo(current.live), document: current.doc };
}

/**
 * A quick read of what the server is running right now.
 *
 * An agent cannot see the process or the workspace; this is how it tells a live
 * server with no diagram open from a dead one whose tools all fail. It costs
 * nothing when nothing is open, so a caller can afford to check before a long
 * build and learn the session was replaced out from under it.
 */
export function serverStatus(): {
  workspace: string;
  alive: true;
  open: {
    name: string;
    view: DiagramView;
    filePath: string | null;
    dirty: boolean;
    shapes: { entities: number; attributes: number; relationships: number; isas: number };
    live: LiveInfo | null;
  } | null;
} {
  const current = peekSession();
  return {
    workspace: WORKSPACE_ROOT,
    alive: true,
    open: current
      ? {
          name: current.doc.name,
          view: current.doc.view,
          filePath: current.filePath,
          dirty: current.dirty,
          shapes: {
            entities: current.doc.entities.length,
            attributes: current.doc.attributes.length,
            relationships: current.doc.relationships.length,
            isas: current.doc.isas.length,
          },
          live: current.live,
        }
      : null,
  };
}

export function summarizeSession(): {
  filePath: string | null;
  live: LiveInfo | null;
  summary: DiagramSummary;
  outline: string;
} {
  const current = requireSession();
  const summary = summarizeDocument(current.doc, current.filePath);
  return { filePath: current.filePath, live: liveInfo(current.live), summary, outline: summaryOutline(summary) };
}

export function validateSession(): {
  valid: boolean;
  issues: Array<DiagramIssue & { nodeName: string | null }>;
  sqlReadiness: string;
} {
  const current = requireSession();
  thinkIn(current);
  const issues = issuesOf(current.doc);
  return { valid: issues.length === 0, issues, sqlReadiness: describeSqlReadiness(current.doc) };
}

export function sqlForSession(
  dialect: 'standard' | 'postgres' | 'mysql' | 'sqlite' = 'standard',
  dropFirst = false,
): { dialect: string; sql: string } {
  const current = requireSession();
  thinkIn(current);
  try {
    return { dialect, sql: generateSql(current.doc, { dialect, dropFirst }) };
  } catch (error) {
    throw new Error(`${errorMessage(error)} ${describeSqlReadiness(current.doc)}`.trim());
  }
}

export async function arrangeSession(view?: DiagramView): Promise<MutationResult & { summary: DiagramSummary }> {
  const current = requireSession();
  const doc = structuredClone(current.doc);
  if (view) doc.view = view;
  await commit(current, arrangeView(doc, doc.view), null);
  const outcome = await persistAfterMutation();
  return { ...mutation(current.doc, `Arranged ${current.doc.view} view.`), ...outcome,
    summary: summarizeDocument(current.doc, current.filePath) };
}

interface NodeRef {
  id: string;
  name: string;
  kind: 'entity' | 'attribute' | 'relationship' | 'specialization';
}

function candidates(doc: ErdDocument): NodeRef[] {
  return [
    ...doc.entities.map((entity) => ({ id: entity.id, name: entity.name, kind: 'entity' as const })),
    ...doc.attributes.map((attribute) => ({ id: attribute.id, name: attribute.name, kind: 'attribute' as const })),
    ...doc.relationships.map((relationship) => ({ id: relationship.id, name: relationship.name, kind: 'relationship' as const })),
    ...doc.isas.map((isa) => ({ id: isa.id, name: 'specialization', kind: 'specialization' as const })),
  ];
}

function resolveNode(doc: ErdDocument, ref: string): NodeRef {
  const all = candidates(doc);
  const byId = all.find((node) => node.id === ref);
  if (byId) return byId;
  const lower = ref.trim().toLowerCase();
  const byName = all.filter((node) => node.name.toLowerCase() === lower);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw new Error(`"${ref}" matches more than one shape (${byName.map((node) => node.id).join(', ')}). Use the id.`);
  }
  throw new Error(`No entity, attribute, or relationship named "${ref}". Call summarize_diagram for ids and names.`);
}

function resolveEntity(doc: ErdDocument, ref: string): Entity {
  const byId = doc.entities.find((entity) => entity.id === ref);
  if (byId) return byId;
  const lower = ref.trim().toLowerCase();
  const byName = doc.entities.filter((entity) => entity.name.toLowerCase() === lower);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw new Error(`"${ref}" matches more than one entity (${byName.map((entity) => entity.id).join(', ')}). Use the id.`);
  }
  throw new Error(`No entity named "${ref}". Call summarize_diagram for entity names and ids.`);
}

function placeAttribute(doc: ErdDocument, id: string): void {
  const attribute = doc.attributes.find((candidate) => candidate.id === id);
  if (!attribute) return;
  // Ignore the shape being placed, so its unplaced origin does not count as a neighbour.
  const without = { ...doc, attributes: doc.attributes.filter((candidate) => candidate.id !== id), view: 'chen' as const };
  const slot = findAttributeSlot(without, attribute.ownerId);
  if (slot) {
    attribute.x = slot.x;
    attribute.y = slot.y;
  }
}

export async function addEntity(input: {
  name: string;
  kind?: EntityKind;
  attributes?: AttributeSpec[];
  x?: number;
  y?: number;
}): Promise<MutationResult> {
  const current = requireSession();
  const name = requireName(input.name, 'Entity');
  if (current.doc.entities.some((entity) => entity.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`An entity named "${name}" already exists.`);
  }
  const doc = structuredClone(current.doc);
  const used = collectIds(doc);
  const entity: Entity = {
    id: newId('ent', name, used),
    name,
    x: 0,
    y: 0,
    kind: entityKind(input.kind),
  };
  if (doc.view === 'crowfoot') {
    // A table placed in crow's-foot still needs a Chen home for when the
    // notation changes, but it must not push its neighbours around there.
    const chen = findFreeSlot(occupiedBoxes({ ...doc, view: 'chen' }), undefined, NODE_SIZE.entity);
    entity.x = chen.x;
    entity.y = chen.y;
  } else {
    const spot = specPoint(input, `Entity "${name}"`) ?? findFreeSlot(occupiedBoxes(doc), undefined, NODE_SIZE.entity);
    entity.x = spot.x;
    entity.y = spot.y;
  }
  doc.entities.push(entity);
  addAttributeSpecs(doc, entity.id, entity.name, input.attributes ?? [], used,
    (attribute) => placeAttribute(doc, attribute.id));

  let spot = { x: entity.x, y: entity.y };
  if (doc.view === 'crowfoot') {
    // How tall the table is depends on the rows its attributes and generated
    // key produce, so its slot is measured once they exist.
    const table = deriveTables(doc).find((candidate) => candidate.entityId === entity.id)!;
    const occupied = occupiedBoxes({ ...doc, entities: doc.entities.filter((node) => node.id !== entity.id) });
    spot = specPoint(input, `Entity "${name}"`) ??
      findFreeSlot(occupied, undefined, { w: CROW_WIDTH, h: tableHeight(table) });
    entity.crowX = spot.x;
    entity.crowY = spot.y;
  }
  await commit(current, doc, entity.id);
  const outcome = await persistAfterMutation();
  return {
    ...mutation(current.doc, `Added entity ${name} at (${spot.x}, ${spot.y}).`, entity.id),
    ...outcome,
  };
}

export async function addAttribute(input: {
  owner: string;
  name: string;
  kind?: AttributeKind;
  dataType?: string;
  attributes?: AttributeSpec[];
}): Promise<MutationResult> {
  const current = requireSession();
  const owner = resolveNode(current.doc, input.owner);
  if (owner.kind === 'attribute') {
    const attribute = current.doc.attributes.find((candidate) => candidate.id === owner.id);
    if (attribute?.kind !== 'composite') {
      throw new Error(`"${owner.name}" is not a composite attribute, so it cannot own parts.`);
    }
  }
  const name = requireName(input.name, 'Attribute');
  const parts = input.attributes ?? [];
  const doc = structuredClone(current.doc);
  const used = collectIds(doc);
  const ownerSlug = owner.kind === 'specialization' ? 'specialization' : owner.name;
  let added: string | undefined;
  addAttributeSpecs(doc, owner.id, ownerSlug, [{
    name,
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.dataType ? { dataType: input.dataType } : {}),
    ...(parts.length ? { attributes: parts } : {}),
  }], used, (attribute) => {
    added ??= attribute.id;
    placeAttribute(doc, attribute.id);
  });
  await commit(current, doc, added ?? null);
  const outcome = await persistAfterMutation();
  return { ...mutation(current.doc, `Added attribute ${name} to ${owner.name}.`, added), ...outcome };
}

export async function addRelationship(input: RelationshipSpec): Promise<MutationResult> {
  const current = requireSession();
  const name = requireName(input.name, 'Relationship');
  const doc = structuredClone(current.doc);
  const from = resolveEntity(doc, input.from);
  const to = resolveEntity(doc, input.to);
  const [fromCard, toCard] = parseCardinality(input.cardinality);
  const relationship: Relationship = {
    id: newId('rel', name, collectIds(doc)),
    name,
    ...findRelationshipSlot(doc, from.id, to.id),
    kind: relationshipKind(input.kind, from, to),
  };
  const used = collectIds({ ...doc, relationships: [...doc.relationships, relationship] });
  doc.relationships.push(relationship);
  addAttributeSpecs(doc, relationship.id, name, input.attributes ?? [], used,
    (attribute) => placeAttribute(doc, attribute.id));
  const leg = (entity: Entity, card: Cardinality, part: ParticipationSpec | undefined, suffix: string): Leg => ({
    id: newId('leg', `${name}_${suffix}`, used),
    fromId: relationship.id,
    toId: entity.id,
    cardinality: card,
    participation: participationOf(part, card),
  });
  doc.legs.push(leg(from, fromCard, input.fromParticipation, from.name));
  doc.legs.push(leg(to, toCard, input.toParticipation, to.name));
  await commit(current, doc, relationship.id);
  const outcome = await persistAfterMutation();
  return { ...mutation(current.doc, `Added relationship ${name} between ${from.name} and ${to.name}.`, relationship.id), ...outcome };
}

/** Add a specialization to a diagram that is already open. */
export interface AddIsaSpec {
  parent: string;
  children: string[];
  name?: string;
}

export async function addIsa(input: AddIsaSpec): Promise<MutationResult & Awaited<ReturnType<typeof persistAfterMutation>>> {
  const current = requireSession();
  thinkIn(current);
  const doc = structuredClone(current.doc);
  const parent = resolveEntity(doc, input.parent);
  const children = input.children.map((child) => resolveEntity(doc, child));
  if (children.some((child) => child.id === parent.id)) throw new Error('A specialization cannot contain its own base.');
  if (new Set(children.map((child) => child.name)).size !== children.length) throw new Error('Choose different children for the specialization.');
  const name = requireName(input.name ?? 'Specialization', 'Specialization');
  // A specialization that already owns this parent is extended, so the parent keeps its
  // subclasses in one shape rather than splitting over several triangles.
  const existing = doc.isas.find((isa) => isa.parentId === parent.id);
  let target: Isa | undefined;
  if (existing) {
    for (const child of children) if (!existing.childIds.includes(child.id)) existing.childIds.push(child.id);
    target = existing;
  } else {
    const used = collectIds(doc);
    const isa: Isa = {
      id: newId('isa', name, used),
      x: parent.x,
      y: parent.y - NODE_SIZE.isa.h - 16,
      parentId: parent.id,
      childIds: children.map((child) => child.id),
    };
    doc.isas.push(isa);
    target = isa;
  }
  await commit(current, doc, target.id);
  const outcome = await persistAfterMutation();
  return { ...mutation(current.doc, `Added specialization ${name}: ${parent.name} by ${children.map((child) => child.name).join(', ')}.`, target!.id), ...outcome };
}

export async function updateNode(ref: string, patch: {
  name?: string;
  kind?: string;
  dataType?: string;
  x?: number;
  y?: number;
}): Promise<MutationResult & Awaited<ReturnType<typeof persistAfterMutation>>> {
  const current = requireSession();
  const node = resolveNode(current.doc, ref);
  const name = patch.name === undefined ? undefined : requireName(patch.name, 'Shape');
  let move: { x: number; y: number } | null = null;
  if (patch.x !== undefined || patch.y !== undefined) {
    if (node.kind !== 'entity') throw new Error('Only entities can be moved with x and y.');
    if (patch.x === undefined || patch.y === undefined || !Number.isFinite(patch.x) || !Number.isFinite(patch.y)) {
      throw new Error('Moving an entity needs a number for both x and y.');
    }
    move = { x: Math.round(patch.x), y: Math.round(patch.y) };
  }
  const doc = structuredClone(current.doc);
  if (node.kind === 'entity') {
    const entity = doc.entities.find((candidate) => candidate.id === node.id)!;
    if (name !== undefined) entity.name = name;
    if (patch.kind !== undefined) entity.kind = entityKind(patch.kind as EntityKind);
    if (patch.dataType !== undefined) throw new Error('Only attributes have a data type.');
    if (move) {
      if (doc.view === 'crowfoot') {
        // Only the table moves; the Chen position is the other notation's own
        // arrangement, and moving it here would move the shape twice.
        entity.crowX = move.x;
        entity.crowY = move.y;
      } else {
        // Attributes are drawn hanging off their owner, so they travel with it,
        // exactly as dragging the shape does in the canvas.
        const dx = move.x - entity.x;
        const dy = move.y - entity.y;
        entity.x = move.x;
        entity.y = move.y;
        const owned = descendantAttributeIds(doc, entity.id);
        for (const attribute of doc.attributes) {
          if (!owned.has(attribute.id)) continue;
          attribute.x += dx;
          attribute.y += dy;
        }
      }
    }
  } else if (node.kind === 'relationship') {
    const relationship = doc.relationships.find((candidate) => candidate.id === node.id)!;
    if (name !== undefined) relationship.name = name;
    if (patch.kind !== undefined) {
      if (patch.kind !== 'strong' && patch.kind !== 'weak') throw new Error('Relationship kind must be "strong" or "weak".');
      relationship.kind = patch.kind;
    }
    if (patch.dataType !== undefined) throw new Error('Only attributes have a data type.');
  } else if (node.kind === 'attribute') {
    const attribute = doc.attributes.find((candidate) => candidate.id === node.id)!;
    if (name !== undefined) attribute.name = name;
    if (patch.kind !== undefined) {
      const kind = attributeKind(patch.kind, false);
      const hasChildren = doc.attributes.some((candidate) => candidate.ownerId === attribute.id);
      if (hasChildren && kind !== 'composite') {
        throw new Error(`"${attribute.name}" has parts, so its kind must stay composite.`);
      }
      attribute.kind = kind;
    }
    if (patch.dataType !== undefined) {
      const type = dataTypeOf(patch.dataType, attribute.name);
      if (type) attribute.dataType = type;
    }
  } else {
    if (name !== undefined || patch.kind !== undefined || patch.dataType !== undefined) {
      throw new Error('Specializations have no editable name or type; change their parent or children instead.');
    }
  }
  if (move && name === undefined && patch.kind === undefined) {
    // A bare move is a carry: the shape travels under the pointer and is
    // dropped where it was asked to land.
    await commitDrag(current, doc, node.id);
  } else {
    await commit(current, doc, node.id);
  }
  const outcome = await persistAfterMutation();
  const displayName = name ?? node.name;
  const message = move && name === undefined && patch.kind === undefined
    ? `Moved entity ${displayName} to (${move.x}, ${move.y}).`
    : `Updated ${node.kind} ${displayName}.`;
  return { ...mutation(current.doc, message, node.id), ...outcome };
}

export async function removeDiagramNode(ref: string): Promise<MutationResult> {
  const current = requireSession();
  const node = resolveNode(current.doc, ref);
  const beforeAttributes = current.doc.attributes.length;
  // The shapes that disappear, not just the one named: removing a table takes
  // its columns with it, and the loop has to wrap all of them.
  const doomed = [node.id, ...descendantAttributeIds(current.doc, node.id)];
  const doc = removeNode(current.doc, node.id);
  await commitLasso(current, doc, doomed);
  const removedAttributes = beforeAttributes - current.doc.attributes.length;
  const outcome = await persistAfterMutation();
  return {
    ...mutation(current.doc,
      `Removed ${node.kind} ${node.name}${removedAttributes ? ` and ${removedAttributes} attribute${removedAttributes === 1 ? '' : 's'}` : ''}.`),
    ...outcome,
  };
}

export async function updateDiagram(patch: { name?: string; view?: DiagramView }): Promise<MutationResult & { summary: DiagramSummary }> {
  const current = requireSession();
  const doc = structuredClone(current.doc);
  if (patch.name !== undefined) doc.name = requireName(patch.name, 'Diagram');
  if (patch.view !== undefined) {
    if (patch.view !== 'chen' && patch.view !== 'crowfoot') throw new Error('View must be "chen" or "crowfoot".');
    doc.view = patch.view;
  }
  await commit(current, doc, null);
  const outcome = await persistAfterMutation();
  return {
    ...mutation(current.doc, 'Updated the diagram.'),
    ...outcome,
    summary: summarizeDocument(current.doc, current.filePath),
  };
}

export function shareSession(options: { baseUrl?: string; room?: string; includeSnapshot?: boolean } = {}): ShareInfo {
  return shareInfo(requireSession().doc, options);
}

export async function listDiagramFiles(): Promise<Array<{
  path: string;
  name: string | null;
  modified: string;
  size: number;
}>> {
  let entries: Dirent[];
  try {
    entries = await readdir(DIAGRAMS_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: Array<{ path: string; name: string | null; modified: string; size: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
    const fullPath = resolve(DIAGRAMS_ROOT, entry.name);
    try {
      const info = await stat(fullPath);
      let name: string | null = null;
      try {
        const parsed = JSON.parse(await readFile(fullPath, 'utf8')) as Record<string, unknown>;
        name = typeof parsed.name === 'string' ? parsed.name : null;
      } catch {
        // A file that is not a diagram is still worth listing; opening it will explain why.
      }
      files.push({
        path: relative(WORKSPACE_ROOT, fullPath).split('\\').join('/'),
        name,
        modified: info.mtime.toISOString(),
        size: info.size,
      });
    } catch {
      // A file that vanished between listing and stat is not an error worth failing the call.
    }
  }
  return files.sort((a, b) => b.modified.localeCompare(a.modified));
}

export { errorMessage };
