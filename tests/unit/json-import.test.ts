/**
 * The JSON import is a trust boundary: the file comes from the user's disk and
 * may be anything at all. A prototype key is the interesting case, because a
 * property read walks the chain and can answer with an array the file never
 * declared as an own key.
 */

import { describe, expect, it } from 'vitest';
import { parseJsonImport, serializeJson } from '../../src/export';
import { emptyDocument } from '../../src/model/types';

describe('parseJsonImport', () => {
  it('round-trips a real export', () => {
    const doc = emptyDocument('Probe');
    doc.entities.push({ id: 'e1', name: 'Customer', kind: 'strong', x: 10, y: 20 });
    const result = parseJsonImport(serializeJson(doc));
    expect(result.error).toBeNull();
    expect(result.doc?.entities).toHaveLength(1);
    expect(result.doc?.entities[0]?.name).toBe('Customer');
  });

  it.each([
    ['null', 'null'],
    ['an array', '[]'],
    ['a string', '"diagram"'],
    ['an object without entities', '{}'],
    ['entities that are not an array', '{"entities":{}}'],
    ['null entities', '{"entities":null}'],
    ['broken JSON', '{not json'],
    // Own keys only: `__proto__` is not an own property of the parsed object, so
    // this file declares nothing and must be refused rather than accepted empty.
    ['only a prototype key', '{"__proto__":{"entities":[]}}'],
  ])('refuses %s', (_label, text) => {
    const result = parseJsonImport(text);
    expect(result.doc).toBeNull();
    expect(result.error).toBeTruthy();
  });
});
