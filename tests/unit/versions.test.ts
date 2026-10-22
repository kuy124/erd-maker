import { expect, it, vi } from 'vitest';
import { emptyDocument } from '../../src/model/types';
import { readVersions, saveVersion } from '../../src/model/versions';
import { resolveIceServers } from '../../src/collab/provider';

it('retains the latest 20 independent versions and tolerates corrupt storage', () => {
  const room = 'versions-test';
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  window.localStorage.removeItem('erd:versions:' + room);
  const doc = emptyDocument();
  for (let i = 0; i < 23; i++) saveVersion(room, { ...doc, name: `Diagram ${i}` }, `Save ${i}`);
  const versions = readVersions(room);
  expect(versions).toHaveLength(20);
  expect(versions[0]!.doc.name).toBe('Diagram 22');
  expect(versions[19]!.label).toBe('Save 3');
  window.localStorage.setItem('erd:versions:' + room, '{bad');
  expect(readVersions(room)).toEqual([]);
  window.localStorage.removeItem('erd:versions:' + room);
  vi.unstubAllGlobals();
});

it('accepts deployment TURN settings and rejects malformed ICE settings', () => {
  const servers = [{ urls: 'turn:relay.example.com:3478', username: 'temporary', credential: 'token' }];
  expect(resolveIceServers(JSON.stringify(servers))).toEqual(servers);
  expect(() => resolveIceServers('{}')).toThrow();
  expect(resolveIceServers('')).toHaveLength(2);
});
