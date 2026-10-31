/**
 * A compact, line-based way to write a whole diagram in one string.
 *
 * `create_diagram`'s JSON form is precise but deep: an attribute is an object,
 * a nested one is an object inside it, and a relationship repeats `from`/`to`
 * as strings. That is a lot of syntax to get exactly right before anything
 * renders, and a model writing it by hand spends most of its budget on
 * punctuation rather than on the schema.
 *
 * This parser accepts the same model as a few lines of text instead:
 *
 *     Customer
 *       customer_id: INT key
 *       name: TEXT
 *       email: TEXT unique
 *     Order
 *       order_id: INT key
 *       placed_at: TIMESTAMP
 *     Customer 1:N Order as places
 *
 * The grammar is deliberately small — indentation, one colon, and four
 * keywords — so a mistake is reported as a line number and an expectation
 * rather than as a schema validation error about a nested path.
 *
 * The JSON form is still there for everything this cannot express
 * (participation constraints, composite parts on a relationship, and so on).
 * This is the fast path, not the only path.
 */

import type { AttributeKind, EntityKind } from '../src/model/types';
import type { AttributeSpec, EntitySpec, IsaSpec, RelationshipSpec } from './diagram';

/** A problem in the text, always carrying the line it was found on. */
export class CompactError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(`Line ${line}: ${message}`);
    this.name = 'CompactError';
    this.line = line;
  }
}

export interface CompactDiagram {
  entities: EntitySpec[];
  relationships: RelationshipSpec[];
  isas: IsaSpec[];
}

const CARDINALITY = /^(1:1|1:N|N:1|N:M|M:N)$/i;
const ATTRIBUTE_FLAGS: AttributeKind[] = ['simple', 'key', 'unique', 'multivalued', 'derived', 'composite'];

/**
 * Splits trailing attribute-kind words off a fragment.
 *
 * `minWords` keeps a bare name from being eaten: without a colon, the line is
 * the name, and "key" is a legal column name even if it is also a kind.
 */
function splitFlags(text: string, minWords: number): { body: string; kind?: AttributeKind } {
  const words = text.trim().split(/\s+/).filter(Boolean);
  let kind: AttributeKind | undefined;
  while (words.length > minWords) {
    const last = words[words.length - 1]!.toLowerCase();
    const flag = ATTRIBUTE_FLAGS.find((candidate) => candidate === last);
    if (!flag) break;
    kind = flag;
    words.pop();
  }
  return { body: words.join(' '), kind };
}

/** Reads one indented line as an attribute, with an optional type and kind. */
function parseAttribute(text: string, line: number): AttributeSpec {
  const colon = text.indexOf(':');
  const namePart = colon === -1 ? text : text.slice(0, colon);
  const typePart = colon === -1 ? '' : text.slice(colon + 1);

  // A typed line may end in a bare flag ("address: composite"), so the type
  // side is allowed to consume its only word. The name side may carry a flag
  // too ("email unique: TEXT"), but never lose its only word to one.
  const fromType = splitFlags(typePart, 0);
  const fromName = splitFlags(namePart, 1);

  const name = fromName.body.trim();
  if (!name) throw new CompactError('An attribute needs a name before its ":" and type.', line);
  if (fromType.kind && fromName.kind) {
    throw new CompactError('An attribute can have only one kind, e.g. "email: TEXT unique".', line);
  }

  const attribute: AttributeSpec = { name };
  const kind = fromName.kind ?? fromType.kind;
  if (kind) attribute.kind = kind;
  const dataType = fromType.body.trim();
  if (dataType) attribute.dataType = dataType;
  return attribute;
}

/** Reads an entity line: `Name`, `Name weak`, `Name @ x,y`, or both. */
function parseEntity(text: string, line: number): EntitySpec {
  let rest = text;
  const point = /\s*@\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(rest);
  const x = point ? Number(point[1]) : undefined;
  const y = point ? Number(point[2]) : undefined;
  if (point) rest = rest.slice(0, point.index);

  let kind: EntityKind | undefined;
  if (/\s+weak$/i.test(rest)) {
    kind = 'weak';
    rest = rest.replace(/\s+weak$/i, '');
  }

  const name = rest.trim();
  if (!name) throw new CompactError('An entity needs a name.', line);

  const entity: EntitySpec = { name };
  if (kind) entity.kind = kind;
  if (x !== undefined && y !== undefined) {
    entity.x = x;
    entity.y = y;
  }
  return entity;
}

/**
 * Reads a relationship line: `From CARD To`, with optional `as Name` and `weak`.
 *
 * The tail is peeled from the right, so an entity name may contain spaces and
 * still be unambiguous — "Order Line 1:N Line Item as contains" parses the way
 * it reads.
 */
function parseRelationship(text: string, line: number): RelationshipSpec | null {
  let rest = text;
  let kind: 'weak' | undefined;
  if (/\s+weak$/i.test(rest)) {
    kind = 'weak';
    rest = rest.replace(/\s+weak$/i, '');
  }

  let name: string | undefined;
  const named = /\s+as\s+(.+)$/i.exec(rest);
  if (named) {
    name = named[1]!.trim();
    rest = rest.slice(0, named.index);
    if (!name) throw new CompactError('"as" needs a relationship name after it.', line);
  }

  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return null;
  const cardIndex = tokens.findIndex((token) => CARDINALITY.test(token));
  if (cardIndex < 1 || cardIndex === tokens.length - 1) return null;

  const from = tokens.slice(0, cardIndex).join(' ');
  const cardinality = tokens[cardIndex]!.toUpperCase();
  const to = tokens.slice(cardIndex + 1).join(' ');

  const relationship: RelationshipSpec = { name: name ?? `${from} ${to}`, from, to, cardinality };
  if (kind) relationship.kind = kind;
  return relationship;
}

/** Reads a specialization line: `Parent isa Child, Child`. */
function parseIsa(text: string, line: number): IsaSpec | null {
  const match = /^(.+?)\s+isa\s+(.+)$/i.exec(text);
  if (!match) return null;
  const parent = match[1]!.trim();
  const children = match[2]!.split(',').map((child) => child.trim()).filter(Boolean);
  if (!parent) throw new CompactError('"isa" needs a parent entity before it.', line);
  if (children.length === 0) throw new CompactError('"isa" needs at least one subclass after it.', line);
  return { parent, children };
}

/**
 * Removes the indentation every line shares.
 *
 * A model writing the text inside a code block, or pasting it from a document,
 * indents everything by the same amount. That common prefix is not structure, so
 * it is stripped before the grammar reads depth.
 */
function dedent(lines: string[]): string[] {
  let shared = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    shared = Math.min(shared, line.length - line.trimStart().length);
  }
  if (!Number.isFinite(shared) || shared === 0) return lines;
  return lines.map((line) => (line.trim() ? line.slice(shared) : line));
}

/**
 * Turns the text into the entity/relationship/specialization lists that
 * `create_diagram` builds from. Throws `CompactError` on the first bad line.
 */
export function parseCompactDiagram(source: string): CompactDiagram {
  const entities: EntitySpec[] = [];
  const relationships: RelationshipSpec[] = [];
  const isas: IsaSpec[] = [];

  /** The attribute list an indented line should join, and how deep it sits. */
  const open: { indent: number; into: AttributeSpec[] }[] = [];

  const lines = dedent(source.replace(/\r\n?/g, '\n').split('\n'));

  for (let index = 0; index < lines.length; index += 1) {
    const number = index + 1;
    const raw = lines[index]!;
    if (raw.includes('\t')) {
      throw new CompactError('Use spaces, not tabs, for indentation.', number);
    }

    // "Everything after # is a note" keeps the grammar small and lets a model
    // leave the reasoning it used next to the line it applies to.
    const text = raw.replace(/#.*$/, '').trimEnd();
    if (!text.trim()) continue;

    const indent = text.length - text.trimStart().length;
    const body = text.trim();

    if (indent === 0) {
      const isa = parseIsa(body, number);
      if (isa) {
        isas.push(isa);
        open.length = 0;
        continue;
      }

      const relationship = parseRelationship(body, number);
      if (relationship) {
        relationships.push(relationship);
        const into: AttributeSpec[] = [];
        relationship.attributes = into;
        open.length = 0;
        open.push({ indent, into });
        continue;
      }

      const entity = parseEntity(body, number);
      entities.push(entity);
      const into: AttributeSpec[] = [];
      entity.attributes = into;
      open.length = 0;
      open.push({ indent, into });
      continue;
    }

    // Indented: belongs to the deepest open block shallower than this line.
    while (open.length > 0 && open[open.length - 1]!.indent >= indent) open.pop();
    const parent = open[open.length - 1];
    if (!parent) {
      throw new CompactError(
        'This line is indented, but there is no entity or relationship above it to attach it to.',
        number,
      );
    }

    const attribute = parseAttribute(body, number);
    parent.into.push(attribute);
    const into: AttributeSpec[] = [];
    attribute.attributes = into;
    open.push({ indent, into });
  }

  // An attribute list nobody filled in is noise in the JSON, so drop it.
  const prune = (specs: AttributeSpec[]): void => {
    for (const spec of specs) {
      if (!spec.attributes) continue;
      if (spec.attributes.length === 0) delete spec.attributes;
      else prune(spec.attributes);
    }
  };
  const pruneOwner = (spec: { attributes?: AttributeSpec[] }): void => {
    if (!spec.attributes) return;
    if (spec.attributes.length === 0) delete spec.attributes;
    else prune(spec.attributes);
  };
  for (const entity of entities) pruneOwner(entity);
  for (const relationship of relationships) pruneOwner(relationship);

  if (entities.length === 0) {
    throw new CompactError('No entities found. Start with a line naming an entity, e.g. "Customer".', 1);
  }

  return { entities, relationships, isas };
}
