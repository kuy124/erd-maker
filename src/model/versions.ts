import { normalizeDocument } from './snapshot';
import type { ErdDocument } from './types';

export interface SavedVersion { id: string; label: string; date: string; doc: ErdDocument }

export function readVersions(room: string): SavedVersion[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem('erd:versions:' + room) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter(v => v && typeof v.id === 'string' && typeof v.label === 'string' && typeof v.date === 'string')
      .slice(0, 20).map(v => ({ ...v, doc: normalizeDocument(v.doc) }));
  } catch { return []; }
}

export function saveVersion(room: string, doc: ErdDocument, label: string): SavedVersion[] {
  const version = { id: crypto.randomUUID(), label, date: new Date().toISOString(), doc };
  // ponytail: last 20 snapshots, local to this browser; shared history needs a storage service.
  const versions = [version, ...readVersions(room)].slice(0, 20);
  window.localStorage.setItem('erd:versions:' + room, JSON.stringify(versions));
  return versions;
}
