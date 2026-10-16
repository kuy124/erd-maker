/**
 * SQL dialect preference.
 *
 * A dialect is a property of the person, not the diagram: someone exporting to
 * MySQL does so for every diagram, and the choice has nothing to say about the
 * schema itself. It is therefore stored in this browser, like the theme and the
 * notation, rather than in the shared document.
 *
 * Only the auto-increment style of generated surrogate keys depends on it
 * (`generateSql`), because that is the one place the standard SQL spelling is
 * not valid on a real database. Everything else is quoted identifiers and
 * parameterised types that all four targets accept.
 */

import type { SqlOptions } from '../model/sql';

export type SqlDialect = NonNullable<SqlOptions['dialect']>;

export const SQL_DIALECTS: { id: SqlDialect; name: string; note: string }[] = [
  { id: 'standard', name: 'Standard SQL', note: 'Portable INTEGER keys. The default.' },
  { id: 'postgres', name: 'PostgreSQL', note: 'SERIAL keys.' },
  { id: 'mysql', name: 'MySQL', note: 'INT AUTO_INCREMENT keys.' },
  { id: 'sqlite', name: 'SQLite', note: 'INTEGER keys, as SQLite spells them.' },
];

const KEY = 'erd:sql-dialect';

export function isSqlDialect(value: unknown): value is SqlDialect {
  return SQL_DIALECTS.some((dialect) => dialect.id === value);
}

export function savedSqlDialect(): SqlDialect {
  try {
    const stored = localStorage.getItem(KEY);
    return isSqlDialect(stored) ? stored : 'standard';
  } catch {
    return 'standard';
  }
}

export function saveSqlDialect(dialect: SqlDialect): void {
  try {
    localStorage.setItem(KEY, dialect);
  } catch {
    // A blocked store costs the choice, not the session.
  }
}
