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

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  /** Renders disabled and explains why through the title. */
  disabled?: boolean;
  disabledReason?: string;
  /** Draws a rule above, separating this from the item before it. */
  separated?: boolean;
  tone?: 'default' | 'danger';
  shortcut?: string;
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
  const [position, setPosition] = useState(at);
  const restoreFocus = useRef(true);
  const itemsRef = useRef<MenuItem[]>(items);
  itemsRef.current = items;
  // The menu closes on the next interaction whatever it is, so the same
  // listener serves every reason it might go away.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const bounds = ref.current?.getBoundingClientRect();
    if (!bounds) return;
    const next = {
      x: Math.max(8, Math.min(at.x, window.innerWidth - bounds.width - 8)),
      y: Math.max(8, Math.min(at.y, window.innerHeight - bounds.height - 8)),
    };
    setPosition((current) => current.x === next.x && current.y === next.y ? current : next);
  }, [at, items, label]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const node = ref.current;

    const focusables = () =>
      Array.from(node?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []);
    (focusables()[0] ?? node)?.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (!(event.target instanceof Node) || !node?.contains(event.target)) return;
      const shortcut = !event.ctrlKey && !event.metaKey && !event.altKey && itemsRef.current.find(
        (item) => !item.disabled && item.shortcut?.toLowerCase() === event.key.toLowerCase(),
      );
      if (shortcut) {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        shortcut.onSelect();
        return;
      }
      const buttons = focusables();
      if (buttons.length === 0) return;
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const next = (index + step + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        event.stopPropagation();
        buttons[event.key === 'Home' ? 0 : buttons.length - 1]?.focus();
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && node?.contains(event.target)) return;
      restoreFocus.current = false;
      closeRef.current();
    };
    // Scrolling the canvas under an open menu leaves it pointing at nothing.
    const onDismiss = () => { restoreFocus.current = false; closeRef.current(); };
    const onWheel = (event: WheelEvent) => {
      if (event.target instanceof Node && node?.contains(event.target)) return;
      onDismiss();
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', onDismiss);
    window.addEventListener('resize', onDismiss);
    window.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', onDismiss);
      window.removeEventListener('resize', onDismiss);
      window.removeEventListener('wheel', onWheel);
      if (restoreFocus.current && (node?.contains(document.activeElement) || document.activeElement === document.body)) {
        previouslyFocused?.focus?.({ preventScroll: true });
      }
    };
  }, []);

  return (
    <div className="context-menu" role="menu" aria-label={label} tabIndex={-1} ref={ref}
      style={{ left: position.x, top: position.y }}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onKeyDown={(event) => event.stopPropagation()}>
      <div className="context-menu__heading" role="presentation" aria-hidden="true">{label}</div>
      {items.map((item) => (
        <Fragment key={item.label}>
          {item.separated ? <div className="context-menu__separator" role="separator" /> : null}
          <button
            type="button"
            role="menuitem"
            aria-label={item.label}
            aria-keyshortcuts={item.shortcut}
            className={`context-menu__item${item.tone === 'danger' ? ' context-menu__item--danger' : ''}`}
            disabled={item.disabled}
            title={item.disabled ? item.disabledReason ?? item.label : undefined}
            onClick={() => { closeRef.current(); item.onSelect(); }}
          >
            <span className="context-menu__label">{item.label}</span>
            {item.shortcut ? <kbd className="context-menu__shortcut" aria-hidden="true">{item.shortcut}</kbd> : null}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
