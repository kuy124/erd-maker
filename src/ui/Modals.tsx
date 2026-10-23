/**
 * Modals.
 *
 * Two dialogs: share (a link that carries the diagram and the live room) and
 * export (SVG, PNG, JSON, SQL). Both trap focus, close on Escape, and restore
 * focus on close, which is the minimum a dialog has to do.
 *
 * Sharing defaults to a snapshot link: the diagram is in the link, so whoever
 * opens it does not have to wait for the sharer to be online. Unticking gives
 * the short live-room-only link.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { copyText } from '../export';
import { downloadText, fileStem, serializeJson } from '../export';
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
  }, []);

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

export function ShareDialog({ state, onClose }: { state: EditorState; onClose: () => void }) {
  const [copied, setCopied] = useState<'link' | 'room' | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  /*
   * Unticked only when a sync server holds the room.
   *
   * The room id alone carries no diagram: whoever opens such a link stares at
   * "waiting for the diagram" until the sharer's tab is open and reachable —
   * unless the room lives on the sync worker, which keeps it after everyone
   * leaves. So the short link is the default exactly where it works, and
   * everywhere else the link carries the diagram so it opens with nobody
   * online. Ticking or unticking overrides either way.
   */
  const [includeSnapshot, setIncludeSnapshot] = useState(!import.meta.env.VITE_SYNC_URL);
  const linkRef = useRef<HTMLInputElement>(null);
  const roomRef = useRef<HTMLInputElement>(null);
  const linkId = useId();

  const link =
    typeof window === 'undefined'
      ? ''
      : buildShareUrl(window.location.href.split('#')[0]!, state.doc, state.room, includeSnapshot);

  const copy = async (value: string, what: 'link' | 'room') => {
    const ok = await copyText(value);
    if (ok) {
      setCopyError(null);
      setCopied(what);
      window.setTimeout(() => setCopied(null), 2000);
    } else {
      setCopied(null);
      setCopyError('Clipboard access was blocked. Select the ' + (what === 'link' ? 'share link' : 'room code') + ' above and copy it manually.');
      const input = what === 'link' ? linkRef.current : roomRef.current;
      input?.focus();
      input?.select();
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
        {includeSnapshot
          ? 'The diagram is inside this link, so it opens even with nobody online.'
          : 'This is the short link. The diagram comes from the room, so it opens as soon as the sync server or another open tab can supply it.'}
      </p>

      <div className="field">
        <label className="field__label" htmlFor={linkId}>
          Share link
        </label>
        <input id={linkId} ref={linkRef} className="field__input field__input--mono" readOnly value={link} onFocus={(e) => e.target.select()} />
      </div>

      <div className="field">
        <label className="snapshot-option">
          <input type="checkbox" checked={includeSnapshot} onChange={(event) => {
            setIncludeSnapshot(event.target.checked); setCopied(null);
          }} />
          Include diagram snapshot
        </label>
        <p className="field__help">A longer link that carries the diagram, so it opens with nobody online.</p>
      </div>

      <div className="field">
        <span className="field__label">Room code</span>
        <input
          className="field__input field__input--mono"
          readOnly
          value={state.room}
          ref={roomRef}
          onFocus={(e) => e.target.select()}
          aria-label="Room code"
        />
        <p className="field__help">
          Anyone with this room code can join, so treat it like a password.
          {import.meta.env.VITE_SYNC_URL ? ' Live edits pass through the sync server, which can read the diagram.' : ' The code also encrypts peer-to-peer live edits.'}
        </p>
      </div>

      <p className="note note--warn">
        Live changes need a direct browser connection. Without one the link still opens the
        diagram, but later edits will not reach the other browser.
      </p>

      {/*
        The honest answer to "I need this to be somewhere other than my screen",
        for an app with no server: a file. It needs nobody online, it is not a
        link that can be truncated, and whoever receives it opens it with Import
        into their own room. Export also does this, but this is where someone
        asking about sharing is actually looking.
      */}
      <div className="field">
        <span className="field__label">Save a copy to this device</span>
        <p className="field__help">
          Writes the diagram as a JSON file. Anyone can open it with Import, whether or not you are
          online, and it cannot be shortened or truncated in transit.
        </p>
        <button type="button" className="btn" onClick={() =>
          downloadText(serializeJson(state.doc), fileStem(state.doc.name) + '.json', 'application/json')
        }>
          Save a copy
        </button>
      </div>

      <div className="modal__footer" style={{ borderTop: 'none', padding: 'var(--s3) 0 0' }}>
        <button type="button" className="btn btn--primary" onClick={() => copy(link, 'link')}>
          {copied === 'link' ? 'Link copied' : 'Copy link'}
        </button>
        <button type="button" className="btn" onClick={() => copy(state.room, 'room')}>
          {copied === 'room' ? 'Code copied' : 'Copy room code'}
        </button>
      </div>
      {copyError ? <p className="note note--warn" role="alert">{copyError}</p> : null}
    </Modal>
  );
}
