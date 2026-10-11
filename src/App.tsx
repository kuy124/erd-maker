import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChenCanvas } from './canvas/ChenCanvas';
import { CrowFootCanvas } from './canvas/CrowFootCanvas';
import { documentBounds } from './canvas/geometry';
import { createRoom, type RoomHandle } from './collab/provider';
import { PRESENCE_COLORS, presenceInk } from './collab/identity';
import { applyLayout } from './model/layout';
import { findFreeSlot, occupiedBoxes } from './model/placement';
import { deriveTables, deriveLinks, CROW_WIDTH, tableHeight } from './model/crowfoot';
import { emptyDocument, allNodes, sizeOf, type ErdDocument } from './model/types';
import { encodeSnapshot, normalizeDocument, newRoomId, parseShareHash } from './model/snapshot';
import { parseJsonImport, downloadText, serializeJson, fileStem } from './export';
import { useEditor } from './state/useEditor';
import { ExportDialog } from './ui/ExportDialog';
import { Inspector } from './ui/Inspector';
import { ShareDialog } from './ui/Modals';
import { ShapeRail, type ShapeKind } from './ui/ShapeRail';
import { DiagramOutline, ExamplesDialog, HelpPanel } from './ui/WorkspacePanels';

type Dialog = 'share' | 'export' | 'examples' | null;
type Panel = 'build' | 'diagram' | 'properties' | 'help';
interface Session { room: string; seed: ErdDocument | null }

function readSession(): Session {
  const parsed = parseShareHash(window.location.hash);
  return { room: parsed.room ?? newRoomId(), seed: parsed.doc ?? null };
}

export function App() {
  const [session, setSession] = useState(readSession);
  useEffect(() => {
    if (!parseShareHash(window.location.hash).room) {
      const url = new URL(window.location.href);
      url.hash = 'room=' + session.room + (session.seed ? '&d=' + encodeSnapshot(session.seed).replace(/\+/g, '%2B') : '');
      window.history.replaceState(null, '', url);
    }
    const onHashChange = () => {
      const parsed = parseShareHash(window.location.hash);
      if (parsed.room || parsed.doc) setSession(readSession());
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [session.room, session.seed]);
  return <EditorSession key={session.room} session={session} />;
}

/** Own connections in an effect so StrictMode and room navigation both clean up correctly. */
function EditorSession({ session }: { session: Session }) {
  const [room, setRoom] = useState<RoomHandle | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let handle: RoomHandle;
    try {
      handle = createRoom(session.room);
      setRoom(handle);
    } catch {
      setError('Could not open this diagram. Reload the page to try again.');
      return;
    }
    return () => handle.destroy();
  }, [session.room]);
  if (!room) return <main className="loading-editor"><h1>ERD Maker</h1><p role={error ? 'alert' : 'status'}>{error ?? 'Opening your diagram…'}</p></main>;
  return <Editor room={room} seed={session.seed} />;
}

function Editor({ room, seed }: { room: RoomHandle; seed: ErdDocument | null }) {
  const state = useEditor(room, seed);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [openPanel, setOpenPanel] = useState<Panel | null>(null);
  const [leftTab, setLeftTab] = useState<'build' | 'diagram'>('build');
  const [rightTab, setRightTab] = useState<'properties' | 'help'>('properties');
  const [error, setError] = useState<string | null>(null);
  const panelTrigger = useRef<HTMLElement | null>(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const framed = useRef(false);
  const isCrowFoot = state.view === 'crowfoot';
  const isEmpty = allNodes(state.doc).length === 0;

  const showPanel = useCallback((panel: Panel, trigger?: HTMLElement) => {
    if (trigger) panelTrigger.current = trigger;
    setOpenPanel(panel);
    if (panel === 'build' || panel === 'diagram') setLeftTab(panel);
    else setRightTab(panel);
  }, []);
  const closePanel = useCallback(() => {
    setOpenPanel(null);
    setRightTab('properties');
    if (panelTrigger.current?.getClientRects().length) panelTrigger.current.focus();
    else svgRef.current?.focus();
  }, []);
  const select = useCallback((id: string | null) => {
    state.setSelection(id);
    if (id) showPanel('properties');
  }, [state.setSelection, showPanel]);
  const editor = useMemo(() => ({ ...state, setSelection: select }), [state, select]);

  useEffect(() => {
    if (!state.justCreated || state.selection !== state.justCreated) return;
    showPanel('properties');
    const frame = requestAnimationFrame(() => {
      const rect = svgRef.current?.getBoundingClientRect();
      const node = allNodes(state.doc).find((item) => item.id === state.justCreated);
      if (!rect || !node) return;
      const table = state.view === 'crowfoot' ? deriveTables(state.doc).find((item) =>
        item.entityId === node.id || item.rows.some((row) => row.attributeId === node.id)) : null;
      if (state.view === 'crowfoot' && !table) return;
      const rowIndex = table?.rows.findIndex((row) => row.attributeId === node.id) ?? -1;
      const dimensions = table ? { w: CROW_WIDTH, h: rowIndex < 0 ? tableHeight(table) : 44 } : sizeOf(state.doc, node.id);
      const x = table?.x ?? node.x;
      const y = table ? table.y + (rowIndex < 0 ? 0 : 44 + rowIndex * 44) : node.y;
      const panel = document.querySelector('.workspace-panel--right[data-open="true"]')?.getBoundingClientRect();
      const phone = window.matchMedia('(max-width: 767px)').matches;
      const drawer = window.matchMedia('(max-width: 1099px)').matches;
      const width = rect.width - (drawer && !phone ? panel?.width ?? 0 : 0);
      const height = rect.height - (phone ? panel?.height ?? 0 : 0);
      state.setViewport((current) => ({ ...current,
        x: width / 2 - (x + dimensions.w / 2) * current.zoom,
        y: height / 2 - (y + dimensions.h / 2) * current.zoom,
      }));
    });
    return () => cancelAnimationFrame(frame);
  }, [state.justCreated, showPanel]);

  const fitToDoc = useCallback((doc: ErdDocument) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect?.width || !rect.height) return;
    const bounds = documentBounds(doc, 40);
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    const zoom = Math.max(0.25, Math.min(1.2, rect.width / width, rect.height / height));
    state.setViewport(() => ({
      zoom, x: -bounds.minX * zoom + (rect.width - width * zoom) / 2,
      y: -bounds.minY * zoom + (rect.height - height * zoom) / 2,
    }));
  }, [state.setViewport]);
  const fitToView = useCallback(() => fitToDoc(state.doc), [fitToDoc, state.doc]);

  useEffect(() => {
    if (!state.loaded || framed.current) return;
    framed.current = true;
    if (!isEmpty) requestAnimationFrame(() => fitToDoc(state.doc));
  }, [state.loaded, state.doc, isEmpty, fitToDoc]);

  const zoomBy = (factor: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    state.setViewport((current) => {
      const zoom = Math.max(0.25, Math.min(3, current.zoom * factor));
      const ratio = zoom / current.zoom;
      return { zoom, x: rect.width / 2 - (rect.width / 2 - current.x) * ratio,
        y: rect.height / 2 - (rect.height / 2 - current.y) * ratio };
    });
  };

  const addShape = useCallback((kind: ShapeKind) => {
    if (!state.loaded) return;
    let view = state.view;
    let ownerId: string | null = null;
    if (kind === 'attribute') {
      const attribute = state.doc.attributes.find((item) => item.id === state.selection);
      ownerId = [...state.doc.entities, ...state.doc.relationships, ...state.doc.isas]
        .some((item) => item.id === state.selection) ? state.selection : attribute?.ownerId ?? null;
      if (view === 'crowfoot' && !state.doc.entities.some((entity) => entity.id === ownerId)) view = 'chen';
    }
    if (kind === 'isa') view = 'chen';
    if (view !== state.view) state.setView(view);
    const rect = svgRef.current?.getBoundingClientRect();
    const size = view === 'crowfoot' && kind === 'entity' ? { w: CROW_WIDTH, h: 88 } :
      kind === 'attribute' ? { w: 130, h: 42 } : { w: 150, h: 72 };
    const origin = {
      x: ((rect?.width ?? 800) / 2 - state.viewport.x) / state.viewport.zoom - size.w / 2,
      y: ((rect?.height ?? 600) / 2 - state.viewport.y) / state.viewport.zoom - size.h / 2,
    };
    const slot = findFreeSlot(occupiedBoxes({ ...state.doc, view }), origin, size);
    if (kind === 'attribute') state.addAttribute(slot.x, slot.y, ownerId);
    else if (kind === 'entity') state.addEntity(slot.x, slot.y);
    else if (kind === 'relationship') {
      const id = state.addRelationship(slot.x, slot.y);
      if (view === 'chen') setConnectFrom(id);
    } else state.addIsa(slot.x, slot.y);
    showPanel('properties');
  }, [state, showPanel]);

  const tidy = useCallback(() => {
    const arranged = applyLayout(state.doc);
    const positions = new Map<string, { x: number; y: number }>();
    const before = new Map(allNodes(state.doc).map((node) => [node.id, node]));
    for (const node of allNodes(arranged)) {
      const old = before.get(node.id);
      if (old && (old.x !== node.x || old.y !== node.y)) positions.set(node.id, { x: node.x, y: node.y });
    }
    if (positions.size) state.applyPositions(positions);
    fitToDoc(arranged);
  }, [state, fitToDoc]);

  const focusShape = (id: string) => {
    let view = state.view;
    const attribute = state.doc.attributes.find((node) => node.id === id);
    const tables = deriveTables(state.doc);
    const table = tables.find((item) => item.entityId === id || item.rows.some((row) => row.attributeId === id));
    const link = deriveLinks(state.doc).find((item) => item.relId === id);
    if (view === 'crowfoot' && !table && !link) view = 'chen';
    if (view !== state.view) state.setView(view);
    select(id);
    let node = allNodes(state.doc).find((item) => item.id === id);
    if (!node) {
      const leg = state.doc.legs.find((item) => item.id === id);
      node = allNodes(state.doc).find((item) => item.id === leg?.fromId);
    }
    let point = node ? { x: node.x + sizeOf(state.doc, node.id).w / 2, y: node.y + sizeOf(state.doc, node.id).h / 2 } : null;
    if (view === 'crowfoot' && table) {
      const row = table.rows.findIndex((item) => item.attributeId === id);
      point = { x: table.x + CROW_WIDTH / 2, y: table.y + (row < 0 ? tableHeight(table) / 2 : 44 + (row + 0.5) * 44) };
    }
    if (view === 'crowfoot' && link) {
      const a = tables.find((item) => item.entityId === link.fromEntityId)!;
      const b = tables.find((item) => item.entityId === link.toEntityId)!;
      point = { x: (a.x + b.x + CROW_WIDTH) / 2, y: (a.y + b.y) / 2 };
    }
    if (point) requestAnimationFrame(() => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return;
      const panel = document.querySelector('.workspace-panel--right[data-open="true"]')?.getBoundingClientRect();
      const phone = window.matchMedia('(max-width: 767px)').matches;
      const drawer = window.matchMedia('(max-width: 1099px)').matches;
      const width = rect.width - (drawer && !phone ? panel?.width ?? 0 : 0);
      const height = rect.height - (phone ? panel?.height ?? 0 : 0);
      state.setViewport((current) => ({ ...current,
        x: width / 2 - point!.x * current.zoom, y: height / 2 - point!.y * current.zoom,
      }));
    });
    if (attribute && view === 'chen') setConnectFrom(null);
  };

  const openDocument = (doc: ErdDocument) => {
    const url = new URL(window.location.href);
    url.hash = 'room=' + newRoomId() + '&d=' + encodeSnapshot(normalizeDocument(doc)).replace(/\+/g, '%2B');
    window.location.hash = url.hash;
  };
  const onImportFile = async (file: File) => {
    try {
      const result = parseJsonImport(await file.text());
      if (result.error || !result.doc) { setError(result.error); return; }
      openDocument(result.doc);
    } catch {
      setError('Could not read that file. Choose a diagram JSON file and try again.');
    }
  };

  useEffect(() => {
    if (isCrowFoot) setConnectFrom(null);
  }, [isCrowFoot]);
  useEffect(() => {
    if (connectFrom && !allNodes(state.doc).some((node) => node.id === connectFrom)) setConnectFrom(null);
  }, [connectFrom, state.doc]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (dialog) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('[role="dialog"]')) return;
      const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement || target?.isContentEditable === true;
      const command = event.ctrlKey || event.metaKey;
      if (command && event.key.toLowerCase() === 's') {
        event.preventDefault();
        downloadText(serializeJson(state.doc), fileStem(state.doc.name) + '.json', 'application/json');
        return;
      }
      if (event.key === 'Escape' && typing) {
        target?.blur();
        svgRef.current?.focus();
        return;
      }
      if (typing) return;
      if (command) {
        if (event.key.toLowerCase() === 'z') {
          event.preventDefault();
          if (event.shiftKey) state.redo(); else state.undo();
        } else if (event.key.toLowerCase() === 'y') { event.preventDefault(); state.redo(); }
        return;
      }
      if (event.altKey) return;
      switch (event.key.toLowerCase()) {
        case 'e': event.preventDefault(); addShape('entity'); break;
        case 'a': event.preventDefault(); addShape('attribute'); break;
        case 'r': event.preventDefault(); addShape('relationship'); break;
        case 's': event.preventDefault(); addShape('isa'); break;
        case 'v': state.setTool('select'); break;
        case 'c':
          if (isCrowFoot) addShape('relationship'); else state.setTool('connect');
          break;
        case 'h': state.setTool('pan'); break;
        case 'f': event.preventDefault(); fitToView(); break;
        case 'delete': case 'backspace':
          if (state.selection) { event.preventDefault(); state.remove(state.selection); }
          break;
        case 'escape': setConnectFrom(null); state.setSelection(null); closePanel(); break;
        case '?': showPanel('help'); break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [state, isCrowFoot, addShape, fitToView, closePanel, showPanel, dialog]);

  // VisualViewport shrinks when a phone keyboard opens; sheets stay above it.
  useEffect(() => {
    const update = () => {
      const height = window.visualViewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty('--viewport-height', height + 'px');
      setKeyboardOpen(height < window.innerHeight * 0.75);
    };
    update();
    window.visualViewport?.addEventListener('resize', update);
    window.addEventListener('resize', update);
    return () => {
      window.visualViewport?.removeEventListener('resize', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  const peerSummary = state.peers.length === 0 ? 'Editing alone' :
    'Editing with ' + state.peers.map((peer) => peer.name).join(', ');
  const closeDialog = useCallback(() => setDialog(null), []);
  const emptyActions = isEmpty ? <div className="starter-actions">
    <button type="button" className="btn btn--primary" disabled={!state.loaded} onClick={() => addShape('entity')}>Add your first entity</button>
    <button type="button" className="btn" onClick={() => setDialog('examples')}>Open an example</button>
  </div> : null;

  return (
    <div className="app" data-keyboard={keyboardOpen}>
      <a className="skip-link" href="#canvas-region" onClick={(event) => { event.preventDefault(); svgRef.current?.focus(); }}>Skip to the canvas</a>
      <header className="topbar">
        <h1 className="wordmark"><span className="wordmark__mark" aria-hidden="true">▢</span>ERD Maker</h1>
        <div className="document-title">
          <label className="visually-hidden" htmlFor="doc-name">Diagram name</label>
          <input id="doc-name" className="docname" value={state.doc.name} disabled={!state.loaded}
            onChange={(event) => state.setDocName(event.target.value)} placeholder="Untitled diagram" autoComplete="off" />
          <span className="storage-label">{state.loaded ? 'Saves in this browser' : 'Opening diagram…'}</span>
        </div>
        <span className="topbar__spacer" />
        <div className="presence" title={peerSummary} aria-label={peerSummary}>
          <span className="presence__avatar" style={{ background: state.identity.color, color: presenceInk(state.identity.color) }}
            title={'You are ' + state.identity.name}>{initials(state.identity.name)}</span>
          {state.peers.slice(0, 3).map((peer) => <span key={peer.clientId} className="presence__avatar" title={peer.name}
            style={{ background: peer.color, color: presenceInk(peer.color) }}>{initials(peer.name)}</span>)}
        </div>
        <div className="file-actions">
          <button type="button" className="btn btn--ghost" onClick={() => openDocument(emptyDocument())}>New</button>
          <button type="button" className="btn" onClick={() => fileInputRef.current?.click()} title="Open a diagram file in a separate room">Import</button>
          <button type="button" className="btn" onClick={() => setDialog('export')}>Export</button>
          <button type="button" className="btn btn--primary" onClick={() => setDialog('share')}>Share</button>
          <button type="button" className="btn btn--ghost desktop-help" onClick={(event) => showPanel('help', event.currentTarget)}>Help</button>
        </div>
        <input ref={fileInputRef} type="file" accept="application/json,.json" className="visually-hidden"
          onChange={(event) => { const file = event.target.files?.[0]; if (file) void onImportFile(file); event.target.value = ''; }}
          tabIndex={-1} aria-hidden="true" />
      </header>

      <div className="editor-toolbar" role="toolbar" aria-label="Diagram tools">
        <div className="seg notation" role="group" aria-label="Notation">
          {(['chen', 'crowfoot'] as const).map((view) => <button key={view} type="button" className="seg__btn" aria-pressed={state.view === view}
            onClick={() => { state.setView(view); requestAnimationFrame(() => fitToDoc({ ...state.doc, view })); }}>{view === 'chen' ? 'Chen' : "Crow's-foot"}</button>)}
        </div>
        <div className="history-tools">
          <button type="button" className="btn btn--ghost" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!state.canUndo} onClick={state.undo}>↶<span className="wide-label"> Undo</span></button>
          <button type="button" className="btn btn--ghost" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!state.canRedo} onClick={state.redo}>↷<span className="wide-label"> Redo</span></button>
        </div>
        <div className="drawing-tools">
          <button type="button" className="btn btn--ghost tool-btn" aria-label="Select tool" aria-pressed={state.tool === 'select'} onClick={() => state.setTool('select')}>Select</button>
          {isCrowFoot ?
            <button type="button" className="btn btn--ghost" aria-label="Add relationship" onClick={() => addShape('relationship')}><span className="wide-label">Add </span>Relationship</button> :
            <button type="button" className="btn btn--ghost tool-btn" aria-label="Connect tool" aria-pressed={state.tool === 'connect'} onClick={() => { state.setTool('connect'); closePanel(); }}>Connect</button>}
          <button type="button" className="btn btn--ghost tool-btn" aria-label="Pan tool" aria-pressed={state.tool === 'pan'} onClick={() => { state.setTool('pan'); closePanel(); }}>Pan</button>
        </div>
        <button type="button" className="btn btn--ghost arrange-btn" onClick={tidy} title="Arrange the diagram automatically">Auto-arrange</button>
      </div>

      <div className="workspace" id="canvas-region">
        <div className="workspace-panel workspace-panel--left" data-open={openPanel === 'build' || openPanel === 'diagram'}>
          <div className="panel-header">
            <div className="seg" role="group" aria-label="Left panel">
              <button type="button" className="seg__btn" aria-pressed={leftTab === 'build'} onClick={() => { setLeftTab('build'); setOpenPanel('build'); }}>Build</button>
              <button type="button" className="seg__btn" aria-pressed={leftTab === 'diagram'} onClick={() => { setLeftTab('diagram'); setOpenPanel('diagram'); }}>Diagram</button>
            </div>
            <button type="button" className="btn btn--ghost panel-close" aria-label="Close panel" onClick={closePanel}>×</button>
          </div>
          {leftTab === 'build' ? <ShapeRail state={editor} onAdd={addShape} onExamples={() => setDialog('examples')} /> :
            <DiagramOutline state={editor} onSelect={focusShape} />}
        </div>

        <div className="canvas-stage">
          {isCrowFoot ? <CrowFootCanvas state={editor} svgRef={svgRef} emptyActions={emptyActions} /> :
            <ChenCanvas state={editor} svgRef={svgRef} connectFrom={connectFrom} setConnectFrom={setConnectFrom} emptyActions={emptyActions} />}
          <div className="viewport-tools" role="group" aria-label="Canvas navigation">
            <button type="button" className="btn btn--ghost" aria-label="Zoom out" disabled={state.viewport.zoom <= 0.25} onClick={() => zoomBy(1 / 1.2)}>−</button>
            <button type="button" className="btn btn--ghost zoom-value" aria-label="Reset zoom to 100%" onClick={() => zoomBy(1 / state.viewport.zoom)}>{Math.round(state.viewport.zoom * 100)}%</button>
            <button type="button" className="btn btn--ghost" aria-label="Zoom in" disabled={state.viewport.zoom >= 3} onClick={() => zoomBy(1.2)}>+</button>
            <button type="button" className="btn btn--ghost" onClick={fitToView} title="Fit the diagram to the window">Fit</button>
          </div>
        </div>

        <div className="workspace-panel workspace-panel--right" data-open={openPanel === 'properties' || openPanel === 'help'}>
          <div className="panel-header panel-header--right">
            <span>{rightTab === 'help' ? 'Help' : 'Properties'}</span>
            <button type="button" className="btn btn--ghost panel-close" aria-label="Close panel" onClick={closePanel}>×</button>
          </div>
          {rightTab === 'help' ? <HelpPanel /> : <Inspector state={editor} />}
        </div>
      </div>

      <footer className="statusbar">
        <span className="diagram-counts">{state.doc.entities.length} entities · {state.doc.relationships.length} relationships · {state.doc.attributes.length} attributes</span>
        <span className="statusbar__spacer" />
        <span className="collaboration-status">{peerSummary}{state.directPeers > 0 ? ' · Direct connection' : state.connected ? ' · Same browser' : ''}</span>
        {connectFrom ? <span className="connection-guidance">Pick a shape to connect <button type="button" className="btn btn--ghost" onClick={() => setConnectFrom(null)}>Cancel</button></span> : null}
      </footer>
      <nav className="panel-navigation" aria-label="Workspace panels">
        {(['build', 'diagram', 'properties', 'help'] as const).map((panel) => <button key={panel} type="button" className="btn btn--ghost"
          aria-expanded={openPanel === panel} onClick={(event) => openPanel === panel ? closePanel() : showPanel(panel, event.currentTarget)}>
          {panel.charAt(0).toUpperCase() + panel.slice(1)}
        </button>)}
      </nav>

      {error ? <div className="feedback feedback--error" role="alert"><span>{error}</span><button type="button" className="btn btn--ghost" onClick={() => setError(null)}>Dismiss</button></div> : null}
      {state.notice ? <div className="feedback" role="status"><span>{state.notice}</span>
        {state.notice.endsWith(' deleted.') ? <button type="button" className="btn" disabled={!state.canUndo} onClick={state.undo}>Undo</button> : null}
        <button type="button" className="btn btn--ghost" aria-label="Dismiss notification" onClick={state.clearNotice}>×</button></div> : null}
      {dialog === 'share' ? <ShareDialog state={editor} onClose={closeDialog} /> : null}
      {dialog === 'export' ? <ExportDialog state={editor} svgRef={svgRef} onClose={closeDialog} /> : null}
      {dialog === 'examples' ? <ExamplesDialog onOpen={openDocument} onClose={closeDialog} /> : null}
    </div>
  );
}

function initials(name: string): string {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?';
}
export { PRESENCE_COLORS };
