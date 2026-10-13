/** Fixed SQL type choices also validate data arriving through JSON, links, or peers. */
export const DATA_TYPES = [
  'TEXT', 'INT', 'BIGINT', 'NUMERIC', 'BOOLEAN', 'DATE', 'TIMESTAMP',
  'UUID', 'JSON', 'BLOB', 'VARCHAR(255)', 'DECIMAL(10,2)',
] as const;

export type DataType = typeof DATA_TYPES[number];

export function normalizeDataType(value: unknown): DataType | undefined {
  const canonical = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return DATA_TYPES.find((type) => type === canonical);
}

/** Legacy name inference remains the default when no explicit type was chosen. */
export function attributeType(attribute: { name: string; dataType?: unknown }): string {
  const chosen = normalizeDataType(attribute.dataType);
  if (chosen) return chosen;
  const name = attribute.name.toLowerCase();
  if (/(^|_)(id|code|number|num|no)($|_)/.test(name) || /(^|_)id$/.test(name)) return 'INT';
  if (/(date|time|created|updated|at)$/.test(name)) return 'TIMESTAMP';
  if (/(amount|price|total|cost|salary|balance|qty|quantity|count)/.test(name)) return 'NUMERIC';
  if (/(is|has|active|enabled|flag)/.test(name)) return 'BOOL';
  return 'TEXT';
}

export function sqlDataType(type: string): string {
  return type === 'INT' ? 'INTEGER' : type === 'BOOL' ? 'BOOLEAN' : type;
}
