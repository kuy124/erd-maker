import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Inspector } from '../../src/ui/Inspector';
import { emptyDocument, type ErdDocument } from '../../src/model/types';
import type { EditorState } from '../../src/state/useEditor';

function document() {
  const doc = emptyDocument(); doc.view = 'crowfoot';
  doc.entities = [{ id: 'e', name: 'Account', kind: 'strong', x: 0, y: 0 }];
  doc.attributes = [{ id: 'a', name: 'account_id', ownerId: 'e', kind: 'key', x: 0, y: 0 }];
  return doc;
}

function properties(doc: ErdDocument, selected = 'a') {
  const state = { doc, selection: [selected], justCreated: null } as unknown as EditorState;
  return new DOMParser().parseFromString(renderToStaticMarkup(createElement(Inspector, { state })), 'text/html');
}

describe('data type properties', () => {
  it('offers automatic inference and supported types for editable Crow’s-foot attributes', () => {
    const dom = properties(document());
    const label = [...dom.querySelectorAll('label')].find((label) => label.textContent === 'Data type');
    expect(label).toBeDefined();
    const select = dom.querySelector<HTMLSelectElement>('#' + label!.htmlFor)!;
    expect(select.disabled).toBe(false);
    expect(select.value).toBe('');
    expect(select.options[0]!.textContent).toContain('INT');
    expect([...select.options].map((o) => o.value)).toContain('DECIMAL(10,2)');
  });

  it('shows the persisted chosen type instead of automatic inference', () => {
    const doc = document(); doc.attributes[0]!.dataType = 'UUID';
    expect(properties(doc).querySelector<HTMLSelectElement>('#attr-data-type')?.value).toBe('UUID');
  });

  it('disables foreign-key type editing and explains the referenced attribute', () => {
    const doc = document(); doc.attributes[0]!.dataType = 'UUID';
    doc.entities.push({ id: 'o', name: 'Order', kind: 'strong', x: 400, y: 0 });
    doc.attributes.push({ id: 'fk', name: 'buyer', ownerId: 'o', kind: 'simple', x: 0, y: 0, dataType: 'TEXT' });
    doc.relationships = [{ id: 'r', name: 'places', kind: 'strong', x: 200, y: 0 }];
    doc.legs = [
      { id: 'l1', fromId: 'r', toId: 'e', cardinality: '1', participation: { min: 0, max: 1 } },
      { id: 'l2', fromId: 'r', toId: 'o', columnId: 'attribute:fk', cardinality: 'N', participation: { min: 0, max: 'N' } },
    ];
    const dom = properties(doc, 'fk');
    const select = dom.querySelector<HTMLSelectElement>('#attr-data-type');
    expect(select?.disabled).toBe(true);
    expect(select?.selectedOptions[0]!.textContent).toContain('UUID');
    expect(dom.body.textContent).toContain('Account.account_id');
    expect(select?.getAttribute('aria-describedby')).toBe('attr-data-type-help');
  });

  it('keeps the type control out of Chen conceptual properties', () => {
    const doc = document(); doc.view = 'chen';
    expect(properties(doc).querySelector('#attr-data-type')).toBeNull();
  });
});
