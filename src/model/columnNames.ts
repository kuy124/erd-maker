/** Shared column naming for the table view and SQL export. */
export function foreignKeyColumnName(table: string, keyName: string): string {
  if (keyName === table) return keyName;
  if (!keyName.startsWith(`${table}_`)) return `${table}_${keyName}`;
  const rest = keyName.slice(table.length + 1);
  return rest === 'id' || rest === 'key' || rest === 'pk' ? keyName : `${table}_${keyName}`;
}

export function toSqlName(name: string): string {
  const cleaned = name.trim().replace(/[\s-]+/g, '_').replace(/[^A-Za-z0-9_]/g, '').toLowerCase();
  return cleaned || 'unnamed';
}
