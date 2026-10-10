/**
 * Modals.
 *
 * Two dialogs: share (a link that carries the diagram and the live room) and
 * export (SVG, PNG, JSON, SQL). Both trap focus, close on Escape, and restore
 * focus on close, which is the minimum a dialog has to do.
 *
 * The share dialog is where the "no server" design has to be explained, because
 * it changes what people expect: the link carries the diagram, so it still works
 * when nobody else is online.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { copyText } from '../export';
import { buildShareUrl } from '../model/snapshot';
import type { EditorState } from '../state/useEditor';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

export function Modal({ title, onClose, children, footer }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const node = ref.current;
    // Focus the first control so the keyboard lands inside the dialog.
    const focusable = node?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !node) return;
      // Trap focus inside the dialog.
      const items = Array.from(
        node.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled'));
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <div className="modal__header">
          <h2 className="modal__title" id={titleId}>
            {title}
          </h2>
          <button type="button" className="btn btn--ghost btn--icon" onClick={onClose} aria-label="Close">
            <CloseGlyph />
          </button>
        </div>
        <div className="modal__body">{children}</div>
        {footer ? <div className="modal__footer">{footer}</div> : null}
      </div>
    </div>
  );
}

function CloseGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3 3 L13 13 M13 3 L3 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/* ------------------------------------------------------------------ share */

export function ShareDialog({
  state,
  onClose,
}: {
  state: EditorState;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<'link' | 'room' | null>(null);
  const linkId = useId();

  const link =
    typeof window === 'undefined'
      ? ''
      : buildShareUrl(window.location.href.split('#')[0]!, state.doc, state.room);

  const copy = async (value: string, what: 'link' | 'room') => {
    const ok = await copyText(value);
    if (ok) {
      setCopied(what);
      window.setTimeout(() => setCopied(null), 2000);
    }
  };

  return (
    <Modal
      title="Share this diagram"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <p className="note" style={{ marginTop: 0 }}>
        Anyone who opens this link joins the same live diagram. The link also carries a copy of the
        diagram itself, so it still opens when nobody else is online.
      </p>

      <div className="field">
        <label className="field__label" htmlFor={linkId}>
          Share link
        </label>
        <input id={linkId} className="field__input field__input--mono" readOnly value={link} onFocus={(e) => e.target.select()} />
      </div>

      <div className="field">
        <span className="field__label">Room code</span>
        <input
          className="field__input field__input--mono"
          readOnly
          value={state.room}
          onFocus={(e) => e.target.select()}
          aria-label="Room code"
        />
        <p className="field__help">
          The room code is also the encryption key for live edits. Anyone with it can join, so treat it
          like a password.
        </p>
      </div>

      <p className="note note--warn">
        Live editing uses a direct connection between browsers. On a locked-down network that blocks
        those connections, the link still opens the diagram, but edits will not appear on other screens.
      </p>

      <div className="modal__footer" style={{ borderTop: 'none', padding: 'var(--s3) 0 0' }}>
        <button type="button" className="btn btn--primary" onClick={() => copy(link, 'link')}>
          {copied === 'link' ? 'Link copied' : 'Copy link'}
        </button>
        <button type="button" className="btn" onClick={() => copy(state.room, 'room')}>
          {copied === 'room' ? 'Code copied' : 'Copy room code'}
        </button>
      </div>
    </Modal>
  );
}
