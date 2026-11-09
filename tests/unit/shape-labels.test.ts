import { expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { labelLines, namedNodeSize } from '../../src/model/types';
import { RelationshipShape, AttributeShape, EntityShape } from '../../src/canvas/NodeShapes';

test('long labels retain every character and expand all Chen shape types', () => {
  for (const name of ['menetapkan dosen pembimbing', 'penetapan_pembimbing_id_penetapan', '特殊属性🙂'.repeat(8)]) {
    expect(labelLines(name).join('')).toBe(name);
    for (const kind of ['entity', 'attribute', 'relationship'] as const) {
      expect(namedNodeSize(kind, name).w).toBeGreaterThan(150);
    }
    const props = { selected: false, onPointerDown: () => {} };
    const node = { id: 'n', name, kind: 'strong' as const, x: 0, y: 0 };
    const markup = renderToStaticMarkup(createElement('svg', null,
      createElement(RelationshipShape, { ...props, relationship: node }),
      createElement(EntityShape, { ...props, entity: node }),
      createElement(AttributeShape, { ...props, attribute: { ...node, kind: 'key', ownerId: null, dataType: 'TEXT' } }),
    ));
    expect(markup).not.toContain('…');
    for (const line of labelLines(name)) expect(markup).toContain(`>${line}</tspan>`);
  }
});
