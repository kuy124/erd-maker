/**
 * Error boundary.
 *
 * The point of the boundary is that a render throw must never leave the user
 * staring at a blank page. These are the only tests in the suite that render
 * React, so they are written with `createElement` rather than JSX to match the
 * `.ts` extension vitest collects.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../../src/ui/ErrorBoundary';

// Without this, `act` warns and does not flush effects reliably.
beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });

/** React logs the caught error; silence it so a passing run stays quiet. */
function silenceErrorConsole() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  vi.restoreAllMocks();
});

function render(children: React.ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(children));
  return container;
}

function Boom(): React.ReactElement {
  throw new Error('render exploded');
}

describe('ErrorBoundary', () => {
  it('renders its children while nothing throws', () => {
    const view = render(createElement(ErrorBoundary, null, createElement('p', null, 'the editor')));
    expect(view.textContent).toBe('the editor');
    expect(view.querySelector('[role="alert"]')).toBeNull();
  });

  it('keeps a render throw from blanking the page', () => {
    const consoleError = silenceErrorConsole();
    const view = render(createElement(ErrorBoundary, null, createElement(Boom)));

    // The white screen this replaces had none of these.
    expect(view.querySelector('[role="alert"]')?.textContent).toContain('Your work is saved in this browser');
    expect(view.textContent).toContain('render exploded');
    expect(view.querySelector('button')?.textContent).toBe('Reload the editor');
    expect(consoleError).toHaveBeenCalled();
  });

  it('reports a thrown non-Error value instead of rendering nothing', () => {
    silenceErrorConsole();
    const view = render(
      createElement(ErrorBoundary, null, createElement(() => { throw 'a bare string'; })),
    );
    expect(view.textContent).toContain('a bare string');
  });
});
