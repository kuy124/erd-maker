import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, expect, it } from 'vitest';
import { Modal } from '../../src/ui/Modals';

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });

it('keeps initial input focus through StrictMode and rerenders, then restores the trigger on close', () => {
  const trigger = document.createElement('button');
  const container = document.createElement('div');
  document.body.append(trigger, container);
  trigger.focus();
  const root = createRoot(container);
  const render = (title: string) => createElement(StrictMode, null, createElement(Modal, {
    title, onClose: () => {}, children: createElement('input', { autoFocus: true }),
  }));

  try {
    act(() => root.render(render('Version history')));
    const input = container.querySelector('input')!;
    expect(document.activeElement).toBe(input);
    input.value = 'Before adding invoices';
    act(() => root.render(render('Saved versions')));
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('Before adding invoices');
    act(() => root.render(null));
    expect(document.activeElement).toBe(trigger);
  } finally {
    act(() => root.unmount());
    container.remove();
    trigger.remove();
  }
});
