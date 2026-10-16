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
import { SQL_DIALECTS, savedSqlDialect, saveSqlDialect, type SqlDialect } from './sqlDialect';

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
  // Read once when the dialog opens; the dialog unmounts on close, so the
  // saved choice is what it comes back to.
  const [dialect, setDialect] = useState<SqlDialect>(savedSqlDialect);
  const chooseDialect = (next: SqlDialect) => {
    setDialect(next);
    saveSqlDialect(next);
  };

  /**
   * `generateSql` throws `SqlError` for documents that cannot become a schema
   * yet — a relationship bound to a field that is not a single-column primary
   * key, or one bound to an attribute a collaborator has just deleted. That is
   * a normal modelling state, not a fault, so it must never escape into render:
   * an uncaught render throw unmounts the whole editor and the user gets a
   * blank page instead of an explanation.
   *
   * It is computed for every tab, which is why the failure was so far-reaching:
   * an SVG, PNG, or JSON download was taken down by a problem that only affects
   * SQL. `describeSqlReadiness` below catches the same error and turns it into
   * the message shown under the schema.
   */
  const sql = useMemo(() => {
    try {
      return generateSql(state.doc, { dialect });
    } catch {
      return null;
    }
  }, [state.doc, dialect]);
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
    // The button is disabled when there is no schema, so this is a type guard.
    if (sql === null) {
      setError(sqlReadiness);
      return;
    }
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
          {/*
            The dialect is a property of the person, not the diagram, and it is
            stored in this browser. Only the auto-increment style of generated
            keys depends on it, so the note says so rather than implying the
            whole schema changes.
          */}
          <div className="field">
            <label className="field__label" htmlFor="sql-dialect">SQL dialect</label>
            <select id="sql-dialect" className="field__select" value={dialect}
              aria-describedby="sql-dialect-help"
              onChange={(event) => chooseDialect(event.target.value as SqlDialect)}>
              {SQL_DIALECTS.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
            </select>
            <p id="sql-dialect-help" className="field__help">
              {SQL_DIALECTS.find((option) => option.id === dialect)?.note} Affects generated key columns only.
            </p>
          </div>
          {sql ? (
            <pre className="code" aria-label="Generated SQL">
              {sql}
            </pre>
          ) : null}
          {sqlReadiness !== 'Ready.' ? <p className="note note--warn" role="alert">{sqlReadiness}</p> : null}
          <button
            type="button"
            className="btn btn--primary"
            onClick={exportSql}
            disabled={!sql}
            style={{ marginTop: 'var(--s3)' }}
          >
            Download SQL
          </button>
        </div>
      ) : null}
    </Modal>
  );
}
