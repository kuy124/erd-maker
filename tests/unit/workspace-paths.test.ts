/**
 * The workspace resolver is the only thing standing between a caller-supplied
 * diagram path and the rest of the disk. Each case reaches a file outside the
 * root while still ending in ".json", so the extension check alone lets it by.
 */

import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { FileWorkspace } from '../../mcp/fileWorkspace';

const root = resolve('workspace-root');
const workspace = new FileWorkspace({ root });

describe('file workspace paths', () => {
  it('accepts a path inside the root', () => {
    expect(workspace.resolve('diagrams/sales.json')).toBe(resolve(root, 'diagrams/sales.json'));
  });

  it('accepts an absolute path inside the root', () => {
    expect(workspace.resolve(resolve(root, 'diagrams/sales.json'))).toBe(resolve(root, 'diagrams/sales.json'));
  });

  it.each([
    '../outside.json',
    '../../etc/passwd.json',
    'diagrams/../../outside.json',
    '..\\..\\Windows\\win.json',
    'C:\\Windows\\win.json',
    '/etc/passwd.json',
  ])('refuses a path that escapes the root: %s', (input) => {
    expect(() => workspace.resolve(input)).toThrow();
  });

  it.each([
    // An alternate data stream hangs off a path outside the root. The textual
    // containment comparison stops at the colon and reports "inside".
    'diagrams:ads/../../secret.json',
    'diagrams/a.json:hidden.json',
    '..\\secret.json:stream.json',
  ])('refuses a Windows alternate data stream: %s', (input) => {
    expect(() => workspace.resolve(input)).toThrow(/cannot contain ":"/);
  });

  it.each(['con.json', 'diagrams/nul.json', 'diagrams/COM1.json', 'lpt9.json'])(
    'refuses a reserved device name: %s', (input) => {
      expect(() => workspace.resolve(input)).toThrow(/reserved by the operating system/);
    });

  it('allows a file that merely begins with a device name', () => {
    expect(workspace.resolve('diagrams/nullable.json')).toBe(resolve(root, 'diagrams/nullable.json'));
  });
});
