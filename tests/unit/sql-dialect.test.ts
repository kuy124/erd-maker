import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isSqlDialect,
  saveSqlDialect,
  savedSqlDialect,
  SQL_DIALECTS,
} from '../../src/ui/sqlDialect';

/**
 * A real in-memory storage, so a failure below is the module's logic rather than
 * the environment's. The module's own try/catch would otherwise swallow a broken
 * stub and quietly report the default.
 */
function stubStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => store.clear(),
  });
  return store;
}

describe('sql dialect preference', () => {
  beforeEach(() => { stubStorage(); });

  it('defaults to standard SQL before anything is chosen', () => {
    expect(savedSqlDialect()).toBe('standard');
  });

  it('remembers the choice for the next time the dialog opens', () => {
    saveSqlDialect('mysql');
    expect(savedSqlDialect()).toBe('mysql');
    saveSqlDialect('postgres');
    expect(savedSqlDialect()).toBe('postgres');
  });

  it('ignores a stored value that is not a dialect this build offers', () => {
    // A value written by an older or newer build, or by hand, must not become a
    // dialect `generateSql` would then receive as an unknown target.
    localStorage.setItem('erd:sql-dialect', 'oracle');
    expect(savedSqlDialect()).toBe('standard');
    expect(isSqlDialect('oracle')).toBe(false);
  });

  it('offers standard first, so the portable default is the one people see', () => {
    expect(SQL_DIALECTS[0]!.id).toBe('standard');
    // Every offered dialect is one `isSqlDialect` accepts and the model knows.
    for (const dialect of SQL_DIALECTS) expect(isSqlDialect(dialect.id)).toBe(true);
    expect(SQL_DIALECTS.map((d) => d.id).sort()).toEqual(['mysql', 'postgres', 'sqlite', 'standard']);
  });

  it('each option carries a note, because a bare dialect name does not say what it changes', () => {
    for (const dialect of SQL_DIALECTS) expect(dialect.note.length, dialect.id).toBeGreaterThan(10);
  });
});
