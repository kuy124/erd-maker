/**
 * A workspace backed by Durable Object storage.
 *
 * The service needs somewhere to put diagram JSON that outlives a request. R2
 * would work, but needs a bucket provisioned first; Durable Object storage is
 * already attached to the object that runs the tools, so a deploy needs nothing
 * beyond the Worker itself.
 *
 * Keys are stored with a prefix ("diagrams/customer.json") and values are the
 * same JSON text the disk workspace writes, so a diagram saved locally can be
 * read here and vice versa.
 */

import { assertJsonPath, keyStem, WorkspacePathError, type Workspace, type WorkspaceEntry } from './workspace';

/** The slice of Durable Object storage this needs. */
export interface ObjectStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>;
}

export interface ObjectStorageOptions {
  storage: ObjectStorageLike;
  /** Prefix inside storage, so diagrams sit together. */
  prefix?: string;
  /** Shown to callers asking where diagrams live. */
  label?: string;
}

export class ObjectStorageWorkspace implements Workspace {
  readonly label: string;
  private readonly storage: ObjectStorageLike;
  private readonly prefix: string;

  constructor(options: ObjectStorageOptions) {
    this.storage = options.storage;
    this.prefix = (options.prefix ?? 'diagrams').replace(/\/+$/, '');
    this.label = options.label ?? 'durable-object://' + this.prefix;
  }

  resolve(input: string): string {
    const trimmed = assertJsonPath(input);
    // Normalise away ./ and .. segments before they can escape the prefix.
    const parts: string[] = [];
    for (const segment of trimmed.replace(/\\/g, '/').split('/')) {
      if (!segment || segment === '.') continue;
      if (segment === '..') {
        throw new WorkspacePathError('Diagram paths cannot leave the workspace.');
      }
      parts.push(segment);
    }
    if (parts.length === 0) throw new WorkspacePathError('Pass a diagram path.');
    return this.prefix + '/' + parts.join('/');
  }

  display(key: string): string {
    return key.startsWith(this.prefix + '/') ? key.slice(this.prefix.length + 1) : key;
  }

  async exists(key: string): Promise<boolean> {
    return (await this.storage.get(key)) !== undefined;
  }

  async read(key: string): Promise<string> {
    const value = await this.storage.get<string>(key);
    if (typeof value !== 'string') throw new Error('No diagram at ' + this.display(key) + '.');
    return value;
  }

  async write(key: string, text: string): Promise<void> {
    await this.storage.put(key, text);
  }

  async list(): Promise<WorkspaceEntry[]> {
    const all = await this.storage.list<string>({ prefix: this.prefix + '/' });
    const entries: WorkspaceEntry[] = [];
    for (const [key, value] of all) {
      if (typeof value !== 'string') continue;
      entries.push({
        key,
        modified: new Date(0).toISOString(),
        size: value.length,
        text: value,
      });
    }
    // Storage lists in key order; newest-first is what the tool promises, and
    // without timestamps the name is the only stable ordering available.
    entries.sort((a, b) => a.key.localeCompare(b.key));
    return entries;
  }

  async defaultKey(name: string): Promise<string> {
    const stem = keyStem(name);
    for (let attempt = 1; attempt < 500; attempt += 1) {
      const candidate = this.prefix + '/' + (attempt === 1 ? stem : stem + '-' + attempt) + '.json';
      if (!(await this.exists(candidate))) return candidate;
    }
    throw new Error('Could not find a free name for this diagram.');
  }
}
