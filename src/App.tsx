/**
 * The application shell.
 *
 * Owns the layout, the keyboard shortcuts, and the toolbar. The shortcuts are
 * deliberately single-key and documented in the UI, because a diagram tool is
 * used for long stretches and the mouse is the slow path.
 *
 * Keyboard shortcuts are suppressed while a text field has focus, so typing
 * "a" into an entity name does not add an attribute.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { UndoManager } from 'yjs';
import { ChenCanvas } from './canvas/ChenCanvas';
import { CrowFootCanvas } from './canvas/CrowFootCanvas';
import { documentBounds } from './canvas/geometry';
import { applyLayout } from './model/layout';
import { findFreeSlot, occupiedBoxes } from './model/placement';
import { parseJsonImport, downloadText, serializeJson } from './export';
import { normalizeDocument } from './model/snapshot';
import type { ErdDocument } from './model/types';
import { useEditor } from './state/useEditor';
import { ExportDialog } from './ui/ExportDialog';
import { Inspector } from './ui/Inspector';
import { ShareDialog } from './ui/Modals';
import { ShapeRail } from './ui/ShapeRail';
import { PRESENCE_COLORS, presenceInk } from './collab/identity';

type Dialog = 'share' | 'export' | null;

export function App() {
  const state = useEditor();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isCrowFoot = state.doc.view === 'crowfoot';

  /**
   * Adds a node.
   *
   * Shapes land in the first free slot of a loose grid rather than on top of
   * each other: a shape hidden underneath another cannot be clicked, dragged,
   * or even seen, which reads as the app having dropped it.
   *
   * Attributes are the exception. They go beside their owner, because the
   * connector line is what says which shape an attribute describes. That only
   * works if there is an owner, so an attribute is attached to whatever is
   * selected; with nothing selected it floats and can be claimed later from the
   * inspector.
   */
  const addShape = useCallback(
    (kind: 'entity' | 'attribute' | 'relationship' | 'isa') => {
      if (kind === 'attribute') {
        // Which shape owns the new attribute.
        //
        // Adding an attribute selects it, so a second press of A would find an
        // attribute selected and lose the owner — meaning the second attribute
        // floats free and the third has nothing to attach to. Following the
        // owner of a selected attribute keeps consecutive presses on the same
        // entity, which is what adding several attributes to one thing means.
        const selectedAttribute = state.doc.attributes.find((a) => a.id === state.selection);
        const ownerId =
          state.doc.entities.some((e) => e.id === state.selection) ||
          state.doc.relationships.some((r) => r.id === state.selection) ||
          state.doc.isas.some((i) => i.id === state.selection)
            ? state.selection
            : (selectedAttribute?.ownerId ?? null);
        const { x, y } = findFreeSlot(occupiedBoxes(state.doc));
        state.addAttribute(x, y, ownerId);
        return;
      }

      const { x, y } = findFreeSlot(occupiedBoxes(state.doc));
      if (kind === 'entity') state.addEntity(x, y);
      else if (kind === 'relationship') state.addRelationship(x, y);
      else state.addIsa(x, y);
    },
    [state],
  );

  /**
   * Frames a document in the viewport. Takes the document explicitly rather
   * than reading `state.doc`, because callers such as Tidy need to frame the
   * layout they just computed, which has not been committed back into state
   * yet — reading state there would frame the previous arrangement.
   */
  const fitToDoc = useCallback((doc: ErdDocument) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const bounds = documentBounds(doc, 40);
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    if (width <= 0 || height <= 0) return;
    const zoom = Math.min(1.2, Math.min(rect.width / width, rect.height / height));
    state.setViewport(() => ({
      zoom,
      x: -bounds.minX * zoom + (rect.width - width * zoom) / 2,
      y: -bounds.minY * zoom + (rect.height - height * zoom) / 2,
    }));
  }, [state]);

  const fitToView = useCallback(() => fitToDoc(state.doc), [fitToDoc, state.doc]);

  const tidy = useCallback(() => {
    const arranged = applyLayout(state.doc);
    const positions = new Map<string, { x: number; y: number }>();
    for (const entity of arranged.entities) {
      const before = state.doc.entities.find((e) => e.id === entity.id);
      if (!before || before.x !== entity.x || before.y !== entity.y) {
        positions.set(entity.id, { x: entity.x, y: entity.y });
      }
    }
    for (const rel of arranged.relationships) {
      const before = state.doc.relationships.find((r) => r.id === rel.id);
      if (!before || before.x !== rel.x || before.y !== rel.y) {
        positions.set(rel.id, { x: rel.x, y: rel.y });
      }
    }
    for (const isa of arranged.isas) {
      const before = state.doc.isas.find((i) => i.id === isa.id);
      if (!before || before.x !== isa.x || before.y !== isa.y) {
        positions.set(isa.id, { x: isa.x, y: isa.y });
      }
    }
    for (const attr of arranged.attributes) {
      const before = state.doc.attributes.find((a) => a.id === attr.id);
      if (!before || before.x !== attr.x || before.y !== attr.y) {
        positions.set(attr.id, { x: attr.x, y: attr.y });
      }
    }
    if (positions.size > 0) state.applyPositions(positions);
    // Frame the arrangement we just computed, not the one still in state.
    fitToDoc(arranged);
  }, [state, fitToDoc]);

  const onImportFile = useCallback(
    async (file: File) => {
      const text = await file.text();
      const { doc, error } = parseJsonImport(text);
      if (error || !doc) return;
      // Normalise through the same codec a share link uses, so an imported file
      // cannot inject a shape the renderers do not understand.
      state.replaceDocument(normalizeDocument(doc));
      window.setTimeout(() => fitToView(), 0);
    },
    [state, fitToView],
  );

  // Keyboard shortcuts.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable === true;

      // Save-as-JSON works even while typing, since it does not conflict with
      // any text entry.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        downloadText(serializeJson(state.doc), `${state.doc.name || 'erd'}.json`, 'application/json');
        return;
      }
      if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
      switch (event.key.toLowerCase()) {
        case 'e':
          event.preventDefault();
          addShape('entity');
          break;
        case 'a':
          event.preventDefault();
          addShape('attribute');
          break;
        case 'r':
          event.preventDefault();
          addShape('relationship');
          break;
        case 's':
          event.preventDefault();
          addShape('isa');
          break;
        case 'v':
          state.setTool('select');
          break;
        case 'h':
          state.setTool('pan');
          break;
        case 'f':
          event.preventDefault();
          fitToView();
          break;
        case 'delete':
        case 'backspace':
          if (state.selection) {
            event.preventDefault();
            state.remove(state.selection);
          }
          break;
        case 'escape':
          setConnectFrom(null);
          state.setSelection(null);
          setDialog(null);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [state, addShape, fitToView]);

  // Undo/redo through Yjs's manager, which is CRDT-aware so it never resurrects
  // a node a peer deleted.
  const undoRef = useRef<{ undo: () => void; redo: () => void } | null>(null);
  useEffect(() => {
    const tracked = [
      state.ydoc.getMap('entities'),
      state.ydoc.getMap('attributes'),
      state.ydoc.getMap('relationships'),
      state.ydoc.getMap('isas'),
      state.ydoc.getMap('legs'),
      state.ydoc.getMap('meta'),
    ];
    const manager = new UndoManager(tracked, { captureTimeout: 400 });
    undoRef.current = { undo: () => manager.undo(), redo: () => manager.redo() };
    return () => {
      manager.destroy();
      undoRef.current = null;
    };
  }, [state.ydoc]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const target = event.target as HTMLElement | null;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault();
        undoRef.current?.undo();
      } else if ((event.key.toLowerCase() === 'z' && event.shiftKey) || event.key.toLowerCase() === 'y') {
        event.preventDefault();
        undoRef.current?.redo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const peerSummary = useMemo(() => {
    if (state.peers.length === 0) return 'You are the only one here';
    const names = state.peers.map((p) => p.name);
    if (names.length === 1) return `${names[0]} is here`;
    if (names.length === 2) return `${names[0]} and ${names[1]} are here`;
    return `${names[0]} and ${names.length - 1} others are here`;
  }, [state.peers]);

  return (
    <div className="app">
      <a className="skip-link" href="#canvas-region">
        Skip to the canvas
      </a>

      <header className="topbar">
        <h1 className="wordmark">
          <span className="wordmark__mark" aria-hidden="true">
            ▢
          </span>
          ERD Maker
        </h1>

        <label className="visually-hidden" htmlFor="doc-name">
          Diagram name
        </label>
        <input
          id="doc-name"
          className="docname"
          value={state.doc.name}
          onChange={(event) => state.setDocName(event.target.value)}
          placeholder="Untitled diagram"
          autoComplete="off"
        />

        <span className="topbar__spacer" />

        <div className="presence" title={peerSummary}>
          <span
            className="presence__avatar"
            style={{ background: state.identity.color, color: presenceInk(state.identity.color) }}
            aria-hidden="true"
          >
            {initials(state.identity.name)}
          </span>
          {state.peers.slice(0, 4).map((peer) => (
            <span
              key={peer.clientId}
              className="presence__avatar"
              style={{ background: peer.color, color: presenceInk(peer.color) }}
              title={peer.name}
            >
              {initials(peer.name)}
            </span>
          ))}
          <span className="presence__label">{peerSummary}</span>
        </div>

        <button
          type="button"
          className="btn"
          onClick={() => fileInputRef.current?.click()}
          title="Open a diagram file"
        >
          Import
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="visually-hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void onImportFile(file);
            event.target.value = '';
          }}
          tabIndex={-1}
          aria-hidden="true"
        />

        <button type="button" className="btn" onClick={() => setDialog('export')}>
          Export
        </button>
        <button type="button" className="btn btn--primary" onClick={() => setDialog('share')}>
          Share
        </button>
      </header>

      <div className="workspace" id="canvas-region">
        <ShapeRail state={state} onAdd={addShape} />

        {isCrowFoot ? (
          <CrowFootCanvas state={state} svgRef={svgRef} />
        ) : (
          <ChenCanvas
            state={state}
            svgRef={svgRef}
            connectFrom={connectFrom}
            setConnectFrom={setConnectFrom}
          />
        )}

        <Inspector state={state} />
      </div>

      <footer className="statusbar">
        <div className="statusbar__group">
          <span className="statusbar__count">{state.doc.entities.length}</span>
          <span>entities</span>
          <span className="statusbar__sep" aria-hidden="true" />
          <span className="statusbar__count">{state.doc.relationships.length}</span>
          <span>relationships</span>
          <span className="statusbar__sep" aria-hidden="true" />
          <span className="statusbar__count">{state.doc.attributes.length}</span>
          <span>attributes</span>
        </div>

        <span className="statusbar__spacer" />

        {connectFrom ? (
          <span className="statusbar__group">
            <span className="note">Pick a second shape to connect</span>
            <button type="button" className="btn btn--ghost" onClick={() => setConnectFrom(null)}>
              Cancel
            </button>
          </span>
        ) : null}

        <div className="seg" role="group" aria-label="Notation">
          <button
            type="button"
            className="seg__btn"
            aria-pressed={!isCrowFoot}
            onClick={() => state.setView('chen')}
          >
            Chen
          </button>
          <button
            type="button"
            className="seg__btn"
            aria-pressed={isCrowFoot}
            onClick={() => state.setView('crowfoot')}
          >
            Crow's-foot
          </button>
        </div>

        <button type="button" className="btn btn--ghost" onClick={tidy} title="Arrange the diagram automatically">
          Tidy
        </button>
        <button type="button" className="btn btn--ghost" onClick={fitToView} title="Fit the diagram to the window">
          Fit
        </button>
        <span className="statusbar__sep" aria-hidden="true" />
        <span className="statusbar__count">{Math.round(state.viewport.zoom * 100)}%</span>
      </footer>

      {dialog === 'share' ? <ShareDialog state={state} onClose={() => setDialog(null)} /> : null}
      {dialog === 'export' ? (
        <ExportDialog state={state} svgRef={svgRef} onClose={() => setDialog(null)} />
      ) : null}
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`.toUpperCase();
}

export { PRESENCE_COLORS };
