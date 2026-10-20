/** Shared column naming for the table view and SQL export. */
export function foreignKeyColumnName(table: string, keyName: string): string {
  if (keyName === table) return keyName;
  // A key that already carries the table name is qualified already. Prefixing
  // it again gives `customer_customer_number`, which says nothing extra.
  if (keyName.startsWith(`${table}_`)) return keyName;
  return `${table}_${keyName}`;
}

/**
 * A column name nothing else is using.
 *
 * The plain name is used when it is free. When it is not, the role that asked
 * for it qualifies it, and a number settles the rest: two relationships to
 * the same table each get their own column, and neither is called `id`.
 */
export function uniqueColumnName(taken: Iterable<string>, name: string, role = ''): string {
  const used = new Set(taken);
  if (!used.has(name)) return name;
  if (role) {
    const qualified = `${role}_${name}`;
    if (!used.has(qualified)) return qualified;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${name}_${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

export function toSqlName(name: string): string {
  const cleaned = name.trim().replace(/[\s-]+/g, '_').replace(/[^A-Za-z0-9_]/g, '').toLowerCase();
  return cleaned || 'unnamed';
}
