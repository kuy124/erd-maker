/**
 * The right-click menu.
 *
 * One component with two entry points, because the two cases differ only in
 * what they offer: right-clicking empty paper creates, right-clicking shapes
 * groups. It is a menu and not a set of buttons scattered on the canvas
 * because the actions are the same in both notations and both views, and
 * duplicating that in four places is how the four drift apart.
 *
 * Keyboard behaviour is the minimum a menu has to have: arrows move, Escape
 * closes, Enter activates, and focus returns to whatever was focused before.
 * Without that it is a trap for anyone not using a mouse.
 */

import { useEffect, useRef } from 'react';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  /** Renders disabled and explains why through the title. */
  disabled?: boolean;
  /** Draws a rule above, separating this from the item before it. */
  separated?: boolean;
  tone?: 'default' | 'danger';
}

interface Props {
  /** Viewport coordinates of the pointer that opened the menu. */
  at: { x: number; y: number };
  items: MenuItem[];
  label: string;
  onClose: () => void;
}

export function ContextMenu({ at, items, label, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<MenuItem[]>(items);
  itemsRef.current = items;
  // The menu closes on the next interaction whatever it is, so the same
  // listener serves every reason it might go away.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const node = ref.current;

    const focusables = () =>
      Array.from(node?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []);
    focusables()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      const buttons = focusables();
      if (buttons.length === 0) return;
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const next = (index + step + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
      if (event.key === 'Home') { event.preventDefault(); buttons[0]?.focus(); }
      if (event.key === 'End') { event.preventDefault(); buttons[buttons.length - 1]?.focus(); }
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && node?.contains(event.target)) return;
      closeRef.current();
    };
    // Scrolling the canvas under an open menu leaves it pointing at nothing.
    const onDismiss = () => closeRef.current();

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', onDismiss);
    window.addEventListener('resize', onDismiss);
    window.addEventListener('wheel', onDismiss, { passive: true });
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', onDismiss);
      window.removeEventListener('resize', onDismiss);
      window.removeEventListener('wheel', onDismiss);
      previouslyFocused?.focus?.();
    };
  }, []);

  // Keep the menu on screen when it is opened near an edge, which is where the
  // pointer is whenever the work is happening to begin with.
  const { left, top } = fit(at, items.length);

  return (
    <div className="context-menu" role="menu" aria-label={label} ref={ref} style={{ left, top }}>
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={`context-menu__item${item.tone === 'danger' ? ' context-menu__item--danger' : ''}`}
          disabled={item.disabled}
          title={item.disabled ? item.label : undefined}
          onClick={() => { item.onSelect(); }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** Nudges a menu back inside the window when it would open off the edge. */
function fit(at: { x: number; y: number }, count: number): { left: number; top: number } {
  const margin = 8;
  const width = 220;
  const height = count * 36 + 16;
  const maxLeft = Math.max(margin, window.innerWidth - width - margin);
  const maxTop = Math.max(margin, window.innerHeight - height - margin);
  return {
    left: Math.min(Math.max(at.x, margin), maxLeft),
    top: Math.min(Math.max(at.y, margin), maxTop),
  };
}
