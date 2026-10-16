/**
 * SQL data types.
 *
 * A type is a base plus, for some bases, a length. `VARCHAR` is not a type on
 * its own in any database worth using — `VARCHAR` and `VARCHAR(255)` are
 * different columns — so the choice of base and the number are separate
 * decisions, and the UI asks for them separately. Presets like `VARCHAR(255)`
 * remain valid values; they are just one point in a range rather than a fixed
 * option in a list.
 *
 * Everything arriving here is untrusted: JSON, a share link, or a peer. A
 * parameterised type is therefore parsed and bounded rather than passed through,
 * because an unbounded length is how a link gets to make your SQL exporter emit
 * a column definition nobody can use.
 */

export type DataType = string;

/** Bases offered in Properties, in the order they are offered. */
export const BASE_TYPES = [
  'TEXT', 'VARCHAR', 'CHAR', 'INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'SERIAL',
  'NUMERIC', 'DECIMAL', 'FLOAT', 'DOUBLE PRECISION', 'BOOLEAN',
  'DATE', 'TIME', 'TIMESTAMP', 'UUID', 'JSON', 'JSONB', 'BYTEA', 'ENUM',
] as const;

export type BaseType = typeof BASE_TYPES[number];

/**
 * How many numbers each base takes: none, one, or a precision and a scale.
 *
 * `NUMERIC(p, s)` and `FLOAT(p)` are genuinely different types, so the count is
 * the base's business rather than a detail of the form.
 */
const ARGUMENTS: Partial<Record<BaseType, 0 | 1 | 2>> = {
  VARCHAR: 1, CHAR: 1, NUMERIC: 2, DECIMAL: 2, FLOAT: 1,
};

/** Bounds for a parameter, chosen so no value can make the exporter unusable. */
export const MAX_LENGTH = 65_535;
export const MAX_PRECISION = 1_000;
export const MAX_SCALE = 1_000;

/**
 * `ENUM` is the one base whose argument is a list of strings rather than
 * numbers, so it is parsed and bounded separately. A cap on both the count and
 * each value keeps a hostile share link from producing a column definition that
 * no database will accept — or that would blow up the exported SQL.
 */
export const MAX_ENUM_VALUES = 64;
export const MAX_ENUM_VALUE_LENGTH = 64;
const DEFAULT_ENUM_VALUES = ['value'];

/** Sensible starting points, so choosing a base gives something usable. */
const DEFAULT_ARGUMENTS: Record<string, number[]> = {
  VARCHAR: [255], CHAR: [1], NUMERIC: [10, 2], DECIMAL: [10, 2], FLOAT: [53],
};

const BASE_SET = new Set<string>(BASE_TYPES);

/** The base of a type: `VARCHAR(64)` becomes `VARCHAR`. */
export function baseOf(type: string): BaseType | null {
  const base = type.trim().toUpperCase().replace(/\s*\(.*$/, '').trim();
  return BASE_SET.has(base) ? (base as BaseType) : null;
}

/**
 * The string values of an `ENUM`, in order, or an empty list when the type is
 * not an enum.
 *
 * Values are the ones written between the parentheses, unquoted and unescaped.
 * A value that cannot be represented safely — it is empty, too long, or has
 * lost a quote to a malformed input — makes the whole list come back empty, so
 * a caller treats it as no enum rather than a partially understood one.
 */
export function enumValuesOf(type: string): string[] {
  const trimmed = type.trim();
  if (baseOf(trimmed) !== 'ENUM') return [];
  const open = trimmed.indexOf('(');
  if (open < 0 || !trimmed.endsWith(')')) return [];
  const inner = trimmed.slice(open + 1, -1);
  const values: string[] = [];
  /*
   * Parse the interior as a strict list of quoted strings separated by commas.
   * This is a tiny grammar, not a `match`-the-good-parts-and-hope pass: anything
   * that is not exactly `'a','b'` (modulo whitespace) fails, so `'a',)` — a
   * trailing comma — or `red` (unquoted) are refused rather than silently
   * reduced to the part that happened to look like a value.
   */
  let index = 0;
  const skipSpace = () => { while (index < inner.length && /\s/.test(inner[index]!)) index++; };
  skipSpace();
  if (index >= inner.length) return [];
  while (index < inner.length) {
    if (inner[index] !== "'") return [];
    index++;
    let value = '';
    let closed = false;
    while (index < inner.length) {
      const char = inner[index]!;
      if (char === "'") {
        if (inner[index + 1] === "'") { value += "'"; index += 2; continue; }
        closed = true; index++; break;
      }
      value += char; index++;
    }
    if (!closed) return [];
    if (value.length < 1 || value.length > MAX_ENUM_VALUE_LENGTH || /[\r\n\t]/.test(value)) return [];
    values.push(value);
    skipSpace();
    if (index >= inner.length) break;
    if (inner[index] !== ',') return [];
    index++;
    skipSpace();
    if (index >= inner.length) return [];
  }
  if (values.length < 1 || values.length > MAX_ENUM_VALUES) return [];
  return values;
}

/** Builds a canonical `ENUM('a','b')`, or undefined when the values are unusable. */
export function makeEnumType(values: string[]): DataType | undefined {
  const cleaned = values.map((value) => value.replace(/[\r\n\t]/g, ' ').trim());
  if (cleaned.length < 1 || cleaned.length > MAX_ENUM_VALUES) return undefined;
  const seen = new Set<string>();
  for (const value of cleaned) {
    if (value.length < 1 || value.length > MAX_ENUM_VALUE_LENGTH) return undefined;
    if (seen.has(value)) return undefined;
    seen.add(value);
  }
  return `ENUM(${cleaned.map((value) => `'${value.replace(/'/g, "''")}'`).join(',')})`;
}

/** The default enum offered when `ENUM` is first chosen, so the column is valid. */
export function defaultEnumType(): DataType {
  return makeEnumType(DEFAULT_ENUM_VALUES)!;
}

/**
 * Splits a comma-separated list typed into the Properties field into enum values.
 *
 * The field is for humans, so the quotes are optional here — `red, green` and
 * `'red','green'` both mean the same two values. A quoted value keeps any
 * internal character, commas included, until its closing quote; an unquoted one
 * splits on the next comma. Empty entries (a stray `,,` or trailing comma while
 * typing) are skipped rather than carried through as a blank value.
 */
export function enumValuesFromInput(input: string): string[] {
  const values: string[] = [];
  let index = 0;
  while (index < input.length) {
    // Skip the separators and whitespace before the next value.
    while (index < input.length && (input[index] === ',' || /\s/.test(input[index]!))) index++;
    if (index >= input.length) break;
    if (input[index] === "'") {
      index++;
      let value = '';
      let closed = false;
      while (index < input.length) {
        const char = input[index]!;
        if (char === "'") {
          if (input[index + 1] === "'") { value += "'"; index += 2; continue; }
          closed = true; index++; break;
        }
        value += char; index++;
      }
      // An unterminated quote carries whatever was typed so far — the field is
      // mid-word, not yet wrong — trimmed of the surrounding spaces.
      if (value.trim()) values.push(value.trim());
      if (!closed) break;
    } else {
      let value = '';
      while (index < input.length && input[index] !== ',') { value += input[index]; index++; }
      if (value.trim()) values.push(value.trim());
    }
  }
  return values;
}

/**
 * The numbers in a type, or an empty list when it has none.
 *
 * Non-numeric or absurd values come back as `[]`, so a caller that needs a
 * number gets the base's default rather than something it has to re-check.
 */
export function argumentsOf(type: string): number[] {
  const match = /\(([^)]*)\)\s*$/.exec(type.trim());
  if (!match) return [];
  const parts = (match[1] ?? '').split(',').map((part) => part.trim());
  const numbers: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return [];
    const value = Number(part);
    const limit = numbers.length === 0 ? MAX_LENGTH : MAX_PRECISION;
    if (value < 1 || value > limit) return [];
    numbers.push(value);
  }
  return numbers;
}

/** Builds a type from a base and its numbers, or null when that is not valid. */
export function makeDataType(base: BaseType | string, args: number[] = []): DataType | undefined {
  if (!BASE_SET.has(base)) return undefined;
  // `ENUM` carries string values rather than numbers; choosing it without any
  // gets the default so the column is usable straight away.
  if (base === 'ENUM') return args.length === 0 ? defaultEnumType() : undefined;
  const wanted = ARGUMENTS[base as BaseType] ?? 0;
  if (wanted === 0) return args.length === 0 ? base : undefined;
  const values = args.length === wanted ? args : DEFAULT_ARGUMENTS[base] ?? [];
  if (values.length !== wanted) return undefined;
  const [first, second] = values;
  if (first === undefined || !Number.isInteger(first) || first < 1 || first > MAX_LENGTH) return undefined;
  if (wanted === 2) {
    if (second === undefined || !Number.isInteger(second) || second < 0
      || second > MAX_PRECISION || second > first) return undefined;
    // No space after the comma: this is the canonical form, and it is what the
    // SQL export and the existing presets already contain.
    return `${base}(${first},${second})`;
  }
  return `${base}(${first})`;
}

/**
 * Validates a type that arrived from anywhere.
 *
 * Returns the canonical form, or undefined when it is not a type this editor
 * knows. Untrusted input is discarded rather than repaired: a link claiming
 * `VARCHAR(999999999)` or `DROP TABLE` gets no closer to the model.
 */
export function normalizeDataType(value: unknown): DataType | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const base = baseOf(trimmed);
  if (!base) return undefined;
  // An enum is validated by its values, not its arity. A bare `ENUM` takes the
  // default; `ENUM('a','b')` is canonicalised to the same quoting everywhere.
  if (base === 'ENUM') {
    if (!/\(/.test(trimmed)) return defaultEnumType();
    const values = enumValuesOf(trimmed);
    return values.length ? makeEnumType(values) : undefined;
  }
  const wanted = ARGUMENTS[base] ?? 0;
  if (wanted === 0) return /\(/.test(trimmed) ? undefined : base;
  /*
   * Bare `VARCHAR` takes the default; `VARCHAR(0)` is not a type anybody means
   * and must be rejected rather than quietly repaired. Falling back on any
   * malformed argument would turn a bad link into a plausible-looking column
   * definition that nobody chose.
   */
  const given = /\(/.test(trimmed);
  const args = argumentsOf(trimmed);
  if (!given) return makeDataType(base, DEFAULT_ARGUMENTS[base]);
  if (args.length !== wanted) return undefined;
  return makeDataType(base, args);
}

/**
 * Legacy name inference remains the default when no explicit type was chosen.
 *
 * `BOOL` here is a legacy spelling kept for documents and snapshots written
 * before `BOOLEAN` was a base; `sqlDataType` still translates it.
 */
export function attributeType(attribute: { name: string; dataType?: unknown; sourceName?: string }): string {
  const chosen = normalizeDataType(attribute.dataType);
  if (chosen) return chosen;
  // Projected composite columns retain the leaf name for Automatic inference.
  const name = (attribute.sourceName ?? attribute.name).toLowerCase();
  if (/(^|_)(id|code|number|num|no)($|_)/.test(name) || /(^|_)id$/.test(name)) return 'INT';
  if (/(date|time|created|updated|at)$/.test(name)) return 'TIMESTAMP';
  if (/(amount|price|total|cost|salary|balance|qty|quantity|count)/.test(name)) return 'NUMERIC';
  if (/(is|has|active|enabled|flag)/.test(name)) return 'BOOL';
  return 'TEXT';
}

export function sqlDataType(type: string): string {
  return type === 'INT' ? 'INTEGER' : type === 'BOOL' ? 'BOOLEAN' : type;
}

/** What the Properties form should show for a stored type. */
export function splitDataType(value: unknown): { base: BaseType; args: number[]; enumValues: string[] } {
  const chosen = normalizeDataType(value);
  const base = (chosen && baseOf(chosen)) ?? 'TEXT';
  return { base: base as BaseType, args: argumentsOf(chosen ?? ''), enumValues: enumValuesOf(chosen ?? '') };
}
