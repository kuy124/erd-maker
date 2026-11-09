import { describe, expect, it, vi } from 'vitest';

vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return { ...actual, ...actual.posix, default: actual.posix };
});

import { FileWorkspace } from '../../mcp/fileWorkspace';

const workspace = new FileWorkspace({ root: '/workspace' });

describe('file workspace on POSIX', () => {
  it.each(['C:\\Windows\\win.json', 'C:/Windows/win.json', '\\\\server\\share\\win.json'])(
    'rejects a foreign Windows absolute path: %s', (input) => {
      expect(() => workspace.resolve(input)).toThrow(/Windows absolute paths/);
    });

  it('accepts native absolute and relative paths inside the root', () => {
    expect(workspace.resolve('/workspace/sales.json')).toBe('/workspace/sales.json');
    expect(workspace.resolve('diagrams/sales.json')).toBe('/workspace/diagrams/sales.json');
  });
});
