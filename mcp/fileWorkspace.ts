/**
 * A workspace on this machine's disk: what a local run has always used.
 *
 * Every rule here is the one the service enforced before storage was
 * abstracted — absolute or relative paths resolve against the workspace root,
 * anything escaping it is refused, and only `.json` is accepted — so switching
 * to the interface changes nothing for a local user.
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertJsonPath, keyStem, WorkspacePathError, type Workspace, type WorkspaceEntry } from './workspace';

export interface FileWorkspaceOptions {
  /** Absolute directory that diagrams may not escape. */
  root: string;
  /** Subdirectory of `root` that new diagrams are created in. */
  diagramsDir?: string;
}

export class FileWorkspace implements Workspace {
  readonly label: string;
  private readonly root: string;
  private readonly diagrams: string;

  constructor(options: FileWorkspaceOptions) {
    this.root = resolve(options.root);
    this.diagrams = resolve(this.root, options.diagramsDir ?? 'diagrams');
    this.label = this.root;
  }

  resolve(input: string): string {
    const trimmed = assertJsonPath(input);
    const candidate = isAbsolute(trimmed) ? resolve(trimmed) : resolve(this.root, trimmed);
    const rel = relative(this.root, candidate);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw new WorkspacePathError(`Diagram paths must stay inside ${this.root}.`);
    }
    return candidate;
  }

  display(key: string): string {
    // Relative to the root so a caller sees `diagrams/sales.json`, not the
    // absolute path of whichever machine happens to be serving it.
    const rel = relative(this.root, key);
    return (rel || key).split(sep).join('/');
  }

  async exists(key: string): Promise<boolean> {
    try {
      const info = await stat(key);
      return info.isFile();
    } catch {
      return false;
    }
  }

  async read(key: string): Promise<string> {
    return readFile(key, 'utf8');
  }

  async write(key: string, text: string): Promise<void> {
    await mkdir(dirname(key), { recursive: true });
    await writeFile(key, text, 'utf8');
  }

  async list(): Promise<WorkspaceEntry[]> {
    let names: string[];
    try {
      const entries = await readdir(this.diagrams, { withFileTypes: true });
      names = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    const found: WorkspaceEntry[] = [];
    for (const name of names) {
      const key = join(this.diagrams, name);
      try {
        const info = await stat(key);
        let text: string | null = null;
        try {
          text = await readFile(key, 'utf8');
        } catch {
          // Listed but unreadable: still worth showing, opening will explain.
        }
        found.push({ key, modified: info.mtime.toISOString(), size: info.size, text });
      } catch {
        // Vanished between listing and stat; not worth failing the call.
      }
    }
    return found.sort((a, b) => b.modified.localeCompare(a.modified));
  }

  async defaultKey(name: string): Promise<string> {
    await mkdir(this.diagrams, { recursive: true });
    const stem = keyStem(name);
    for (let index = 1; index < 10_000; index += 1) {
      const candidate = join(this.diagrams, `${stem}${index === 1 ? '' : `-${index}`}.json`);
      if (!(await this.exists(candidate))) return candidate;
    }
    return join(this.diagrams, `${stem}-${Date.now().toString(36)}.json`);
  }
}
