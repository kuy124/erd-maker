/**
 * The export dialog.
 *
 * Four outputs, each labelled by what it produces rather than by format name:
 * "SVG (vector image)", "PNG (image)", "JSON (diagram file)", "SQL (schema)".
 * The SQL tab shows the generated schema before downloading, so it can be
 * checked and copied without a round trip through a file.
 */

import { useMemo, useState } from 'react';
import {
  downloadBlob,
  downloadText,
  fileStem,
  serializeJson,
  serializeSvg,
  svgToPng,
} from '../export';
import { describeSqlReadiness, generateSql } from '../model/sql';
import { documentBounds } from '../canvas/geometry';
import type { EditorState } from '../state/useEditor';
import { Modal } from './Modals';

type Tab = 'svg' | 'png' | 'json' | 'sql';

interface Props {
  state: EditorState;
  svgRef: React.MutableRefObject<SVGSVGElement | null>;
  onClose: () => void;
}

export function ExportDialog({ state, svgRef, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('svg');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const sql = useMemo(() => generateSql(state.doc), [state.doc]);
  const sqlReadiness = useMemo(() => describeSqlReadiness(state.doc), [state.doc]);
  const stem = fileStem(state.doc.name);

  const flash = (message: string) => {
    setStatus(message);
    window.setTimeout(() => setStatus(null), 2600);
  };

  const exportSvg = () => {
    const svg = svgRef.current;
    if (!svg) {
      setError('The canvas is not ready yet.');
      return;
    }
    setError(null);
    const bounds = documentBounds(state.doc, 24);
    const markup = serializeSvg(svg, bounds, { title: state.doc.name });
    downloadText(markup, `${stem}.svg`, 'image/svg+xml');
    flash(`Saved ${stem}.svg`);
  };

  const exportPng = async () => {
    const svg = svgRef.current;
    if (!svg) {
      setError('The canvas is not ready yet.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const bounds = documentBounds(state.doc, 24);
      const markup = serializeSvg(svg, bounds, { title: state.doc.name });
      const png = await svgToPng(markup, 2);
      downloadBlob(png, `${stem}.png`);
      flash(`Saved ${stem}.png`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not make the PNG.');
    } finally {
      setBusy(false);
    }
  };

  const exportJson = () => {
    downloadText(serializeJson(state.doc), `${stem}.json`, 'application/json');
    flash(`Saved ${stem}.json`);
  };

  const exportSql = () => {
    downloadText(sql, `${stem}.sql`, 'text/plain');
    flash(`Saved ${stem}.sql`);
  };

  return (
    <Modal
      title="Export"
      onClose={onClose}
      footer={
        <>
          {status ? <span className="note" role="status">{status}</span> : null}
          {error ? <span className="note note--warn" role="alert">{error}</span> : null}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div className="seg" role="tablist" aria-label="Export format" style={{ marginBottom: 'var(--s4)' }}>
        {(
          [
            ['svg', 'SVG'],
            ['png', 'PNG'],
            ['json', 'JSON'],
            ['sql', 'SQL'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            className="seg__btn"
            aria-selected={tab === value}
            aria-pressed={tab === value}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'svg' ? (
        <div>
          <p className="note" style={{ marginTop: 0 }}>
            A vector image that stays sharp at any size. Use it in reports, slides, or print. Editing
            marks like selection outlines are left out.
          </p>
          <button type="button" className="btn btn--primary" onClick={exportSvg}>
            Download SVG
          </button>
        </div>
      ) : null}

      {tab === 'png' ? (
        <div>
          <p className="note" style={{ marginTop: 0 }}>
            An image file at twice the on-screen resolution, for pasting into a document or a chat.
          </p>
          <button type="button" className="btn btn--primary" onClick={() => void exportPng()} disabled={busy}>
            {busy ? 'Making the image…' : 'Download PNG'}
          </button>
        </div>
      ) : null}

      {tab === 'json' ? (
        <div>
          <p className="note" style={{ marginTop: 0 }}>
            The diagram itself. Keep it to reopen the diagram later with Import, or to keep it in
            version control.
          </p>
          <button type="button" className="btn btn--primary" onClick={exportJson}>
            Download JSON
          </button>
        </div>
      ) : null}

      {tab === 'sql' ? (
        <div>
          <p className="note" style={{ marginTop: 0 }}>
            The schema this diagram describes. Key attributes become the primary key, and each
            relationship becomes a foreign key or its own table.
          </p>
          <pre className="code" aria-label="Generated SQL">
            {sql}
          </pre>
          {sqlReadiness !== 'Ready.' ? <p className="note note--warn">{sqlReadiness}</p> : null}
          <button
            type="button"
            className="btn btn--primary"
            onClick={exportSql}
            style={{ marginTop: 'var(--s3)' }}
          >
            Download SQL
          </button>
        </div>
      ) : null}
    </Modal>
  );
}
