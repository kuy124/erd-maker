/**
 * What "the workspace" means to the diagram service.
 *
 * The service needs five things: resolve a caller-supplied path, ask whether a
 * file exists, read it, write it, and list what is there. It needs nothing else
 * — and crucially it must not know whether those five things happen on a disk
 * or in a bucket, because that is the difference between a server that only
 * runs on someone's laptop and one that can be hosted.
 *
 * `key` is opaque. On disk it is an absolute path; in object storage it is the
 * object name. The service only ever passes it back to the same workspace, so
 * it never has to interpret one.
 */

/** A caller supplied a path the workspace refuses to resolve. */
export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspacePathError';
  }
}

export interface WorkspaceEntry {
  /** Opaque handle, usable with `read` and `display`. */
  key: string;
  /** ISO timestamp, for newest-first listing. */
  modified: string;
  /** Bytes, for the listing. */
  size: number;
  /** Contents, or null when the file could not be read. */
  text: string | null;
}

export interface Workspace {
  /** Where diagrams are kept, shown to callers asking about the workspace. */
  readonly label: string;
  /** Turns a caller-supplied path into a key, refusing anything unsafe. */
  resolve(input: string): string;
  /** Turns a key back into something worth showing a caller. */
  display(key: string): string;
  exists(key: string): Promise<boolean>;
  read(key: string): Promise<string>;
  write(key: string, text: string): Promise<void>;
  /** Every diagram, newest first. */
  list(): Promise<WorkspaceEntry[]>;
  /** A free path for a diagram that did not name one. */
  defaultKey(name: string): Promise<string>;
}

/** Trims and validates the shape of a caller-supplied path. */
export function assertJsonPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new WorkspacePathError('Pass a diagram path.');
  if (!trimmed.toLowerCase().endsWith('.json')) {
    throw new WorkspacePathError('Diagram files must use a .json extension.');
  }
  return trimmed;
}

/** The file stem used for a diagram that did not name a path. */
export function keyStem(name: string): string {
  // Same rule the service used before the abstraction: spaces and hyphens
  // become underscores, everything else goes, and an empty name is "unnamed".
  // Duplicated rather than imported so this module stays free of app code.
  const cleaned = name.trim().replace(/[\s-]+/g, '_').replace(/[^A-Za-z0-9_]/g, '').toLowerCase();
  return cleaned || 'unnamed';
}
