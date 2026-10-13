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
  it('offers automatic inference and a base per supported type', () => {
    const dom = properties(document());
    const label = [...dom.querySelectorAll('label')].find((label) => label.textContent === 'Data type');
    expect(label).toBeDefined();
    const select = dom.querySelector<HTMLSelectElement>('#' + label!.htmlFor)!;
    expect(select.disabled).toBe(false);
    expect(select.value).toBe('');
    expect(select.options[0]!.textContent).toContain('INT');
    // Bases, not fixed presets: `VARCHAR` and `VARCHAR(64)` are different
    // columns, so the numbers are a separate control.
    const bases = [...select.options].map((o) => o.value);
    for (const base of ['TEXT', 'VARCHAR', 'INT', 'DECIMAL', 'NUMERIC', 'UUID', 'BOOLEAN']) {
      expect(bases).toContain(base);
    }
  });

  it('asks for the numbers a base needs, and only those', () => {
    const doc = document();
    doc.attributes[0]!.dataType = 'VARCHAR(64)';
    const dom = properties(doc);
    expect(dom.querySelector<HTMLSelectElement>('#attr-data-type')?.value).toBe('VARCHAR');
    const length = dom.querySelector<HTMLInputElement>('#attr-type-length')!;
    expect(length.type).toBe('number');
    expect(length.value).toBe('64');
    // A one-number base has no second input.
    expect(dom.querySelector('#attr-type-scale')).toBeNull();

    const money = document();
    money.attributes[0]!.dataType = 'DECIMAL(12,4)';
    const moneyDom = properties(money);
    expect(moneyDom.querySelector<HTMLInputElement>('#attr-type-precision')?.value).toBe('12');
    expect(moneyDom.querySelector<HTMLInputElement>('#attr-type-scale')?.value).toBe('4');

    // And a base with no numbers asks for none.
    const plain = document();
    plain.attributes[0]!.dataType = 'INT';
    const plainDom = properties(plain);
    expect(plainDom.querySelector<HTMLSelectElement>('#attr-data-type')?.value).toBe('INT');
    expect(plainDom.querySelector('#attr-type-length')).toBeNull();
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
