import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChenCanvas } from './canvas/ChenCanvas';
import { CrowFootCanvas } from './canvas/CrowFootCanvas';
import { cursorOrigin, documentBounds, isVisibleIn } from './canvas/geometry';
import { createRoom, type RoomHandle } from './collab/provider';
import { PRESENCE_COLORS, presenceInk } from './collab/identity';
import { applyLayout } from './model/layout';
import { findFreeSlot, occupiedBoxes } from './model/placement';
import { deriveTables, deriveLinks, routeColumns, CROW_WIDTH, tableHeight, tableObstacle } from './model/crowfoot';
import { placeRouteCaption } from './model/connectorRouting';
import { emptyDocument, allNodes, sizeOf, type ErdDocument } from './model/types';
import { encodeSnapshot, normalizeDocument, newRoomId, parseShareHash } from './model/snapshot';
import { readVersions, saveVersion, deleteVersion } from './model/versions';
import { parseJsonImport, downloadText, serializeJson, fileStem } from './export';
import { useEditor, type EditorState } from './state/useEditor';
import { ExportDialog } from './ui/ExportDialog';
import { Inspector } from './ui/Inspector';
import { ContextMenu, type MenuItem } from './ui/ContextMenu';
import { ShareDialog, Modal } from './ui/Modals';
import { ShapeRail, type ShapeKind } from './ui/ShapeRail';
import { DiagramOutline, ExamplesDialog, HelpPanel, ThemePicker } from './ui/WorkspacePanels';
import { savedTheme, THEMES } from './ui/theme';
import { WorkspaceIcon } from './ui/WorkspaceIcon';

type Dialog = 'share' | 'export' | 'examples' | 'theme' | 'name' | null;
type Panel = 'build' | 'diagram' | 'properties' | 'help';
interface Session { room: string; seed: ErdDocument | null; fromLink: boolean }

/**
 * Where the right-click menu was opened.
 *
 * `shape` is true when the pointer was over something, which is what separates
 * the grouping actions from the creating ones. The world point is kept so a new
 * shape appears exactly where the pointer is rather than wherever the last one
 * happened to land.
 */
interface MenuRequest { at: { x: number; y: number }; world: { x: number; y: number }; shape: boolean }

function readSession(): Session {
  const parsed = parseShareHash(window.location.hash);
  /*
   * Is this room ours or somebody else's?
   *
   * The hash is rewritten on load to always name the current room, so a reload
   * of a diagram you opened yourself is indistinguishable from a link that
   * arrived from elsewhere — the difference is whether *this* app put the room
   * in the hash, which `history.state` survives a reload. Without it there is no
   * way to tell "waiting for the person who shared this" from "you have an
   * empty diagram", and guessing wrong on an empty canvas is how a joiner ends
   * up drawing a fresh schema over somebody else's work.
   */
  const generated = (window.history.state as { room?: string } | null)?.room;
  return {
    room: parsed.room ?? newRoomId(),
    seed: parsed.doc ?? null,
    fromLink: Boolean(parsed.room) && generated !== parsed.room,
  };
}

export function App() {
  const [session, setSession] = useState(readSession);
  useEffect(() => {
    if (!parseShareHash(window.location.hash).room) {
      const url = new URL(window.location.href);
      url.hash = 'room=' + session.room + (session.seed ? '&d=' + encodeSnapshot(session.seed).replace(/\+/g, '%2B') : '');
      // Record that this room was invented here, so a reload is not mistaken
      // for somebody else's link. See `readSession`.
      window.history.replaceState({ room: session.room }, '', url);
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
  return <Editor room={room} seed={session.seed} fromLink={session.fromLink} />;
}

function Editor({ room, seed, fromLink }: { room: RoomHandle; seed: ErdDocument | null; fromLink: boolean }) {
  const state = useEditor(room, seed);
  const isCrowFoot = state.view === 'crowfoot';

  /*
   * Crow's-foot placement is shared, and separate from Chen.
   *
   * Two people reading one schema are looking at the same tables, so a table
   * moved here moves for everybody — that is what the notification column is
   * for. It is stored as `crowX`/`crowY` rather than as the entity's `x`/`y`, so
   * arranging one notation never rearranges the other. A table with no
   * Crow's-foot position yet is given one by arranging the tables themselves
   * rather than by inheriting where its entity sits in Chen; that inheritance is
   * the carry-over that reads as "why did my diagram jump when I changed
   * notation".
   */
  const shown = state.doc;


  // The name field is a draft so it can be emptied to be retyped; the identity
  // only ever holds a name that was actually committed.
  const [nameDraft, setNameDraft] = useState(state.identity.name);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileMenuTrigger = useRef<HTMLButtonElement>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versionName, setVersionName] = useState('');
  const [versions, setVersions] = useState(() => readVersions(state.room));
  const [arrangeUndo, setArrangeUndo] = useState(false);
  const checkpoint = (label: string) => {
    try { setVersions(saveVersion(state.room, state.doc, label)); }
    catch { setError('Could not save this version. Browser storage may be full or unavailable.'); }
  };
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [openPanel, setOpenPanel] = useState<Panel | null>(null);
  const [leftTab, setLeftTab] = useState<'build' | 'diagram'>('build');
  const [rightTab, setRightTab] = useState<'properties' | 'help'>('properties');
  const [error, setError] = useState<string | null>(null);
  const panelTrigger = useRef<HTMLElement | null>(null);
  const focusPanel = useRef(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [menu, setMenu] = useState<MenuRequest | null>(null);
  const [fileMenuAt, setFileMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const framed = useRef(false);
  const isEmpty = allNodes(state.doc).length === 0;

  const showPanel = useCallback((panel: Panel, trigger?: HTMLElement, keyboard = false) => {
    if (trigger) panelTrigger.current = trigger;
    focusPanel.current = keyboard;
    setFocusMode(false);
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
  /**
   * Double-clicking a shape reveals its properties, the shortcut a mouse user
   * reaches for before hunting the panel controls.
   *
   * The first press of the double-click has already selected the shape, so this
   * only opens the panel — it never changes the selection. Under Pan or Connect
   * a press pans or draws instead of selecting, so the selection on screen is
   * not the thing under the pointer, and nothing opens. An empty double-click
   * clears the selection in the same gesture, which the length check catches.
   */
  const revealProperties = useCallback(() => {
    if (state.tool !== 'select' || state.selection.length !== 1) return;
    showPanel('properties');
  }, [state.tool, state.selection, showPanel]);
  const select = state.setSelection;
  const editor: typeof state = { ...state, doc: shown, setViewport: (update) => {
    // Canvas gestures take ownership of the view while a live room is loading.
    framed.current = true;
    state.setViewport(update);
  } };
  const toggleFocus = useCallback(() => {
    setFocusMode((current) => !current);
    setOpenPanel(null);
    setMenu(null);
    setFileMenuAt(null);
    requestAnimationFrame(() => svgRef.current?.focus());
  }, []);

  // Floating controls and open panels leave the canvas size unchanged. Frame
  // shapes inside the unobscured part of it instead of moving them under a panel.
  const canvasArea = useCallback(() => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const app = svgRef.current?.closest('.app');
    const quiet = app?.getAttribute('data-focus') === 'true' || app?.getAttribute('data-keyboard') === 'true';
    const phone = window.matchMedia('(max-width: 767px)').matches;
    let left = quiet || phone ? 20 : 72;
    let right = 20;
    const top = quiet ? 20 : phone ? 124 : 80;
    let bottom = quiet ? 20 : phone ? 124 : 80;
    for (const panel of app?.querySelectorAll('.workspace-panel[data-open="true"]') ?? []) {
      const bounds = panel.getBoundingClientRect();
      if (phone) bottom = Math.max(bottom, rect.bottom - bounds.top + 12);
      else if (panel.classList.contains('workspace-panel--left')) left = Math.max(left, bounds.right - rect.left + 12);
      else right = Math.max(right, rect.right - bounds.left + 12);
    }
    return { x: left, y: top, width: Math.max(1, rect.width - left - right), height: Math.max(1, rect.height - top - bottom) };
  }, []);

  const fitToDoc = useCallback((doc: ErdDocument) => {
    const area = canvasArea();
    if (!area) return;
    const bounds = documentBounds(doc, 40);
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    const zoom = Math.max(0.25, Math.min(1.2, area.width / width, area.height / height));
    state.setViewport(() => ({
      zoom, x: area.x - bounds.minX * zoom + (area.width - width * zoom) / 2,
      y: area.y - bounds.minY * zoom + (area.height - height * zoom) / 2,
    }));
  }, [state.setViewport, canvasArea]);
  const fitToView = useCallback(() => fitToDoc(shown), [fitToDoc, shown]);

  useEffect(() => {
    if (!isCrowFoot || !state.loaded) return;
    const missing = state.doc.entities.filter((entity) => entity.crowX === undefined || entity.crowY === undefined);
    if (missing.length === 0) return;
    const crowPlaced = new Set(
      state.doc.entities.filter((e) => e.crowX !== undefined && e.crowY !== undefined).map((e) => e.id),
    );
    // Arrange the tables as tables. Positions already chosen are kept: this
    // only fills gaps, so re-running cannot rearrange what is settled.
    const arranged = applyLayout(state.doc);
    const fresh = new Map<string, { x: number; y: number }>();
    const tables = deriveTables(state.doc);
    const occupied = tables.filter(table => crowPlaced.has(table.entityId))
      .map(table => ({ x: table.x, y: table.y, w: table.width, h: tableHeight(table) }));
    for (const entity of arranged.entities) {
      if (crowPlaced.has(entity.id)) continue;
      const table = tables.find(table => table.entityId === entity.id)!;
      const size = { w: table.width, h: tableHeight(table) };
      const point = findFreeSlot(occupied, { x: entity.x, y: entity.y }, size);
      fresh.set(entity.id, point);
      occupied.push({ ...point, ...size });
    }
    if (fresh.size === 0) return;
    // Shared, like every other edit: two people in the room see the same tables.
    // Untracked on purpose — see `placeTables`.
    state.placeTables(fresh);
    /*
     * Frame the layout that was just placed, explicitly.
     *
     * Waiting for the automatic first frame does not work here. Switching
     * notation clears `framed`, so a frame runs against the positions as they
     * are *before* placing, claims the flag, and then blocks itself when the
     * real positions arrive.
     */
    requestAnimationFrame(() => {
      framed.current = false;
      const placed = new Map(arranged.entities.map((entity) =>
        [entity.id, { x: fresh.get(entity.id)?.x ?? entity.crowX ?? entity.x,
          y: fresh.get(entity.id)?.y ?? entity.crowY ?? entity.y }] as const));
      fitToDoc({ ...state.doc, entities: state.doc.entities.map((entity) => {
        const at = placed.get(entity.id);
        return at ? { ...entity, crowX: at.x, crowY: at.y } : entity;
      }) });
    });
  }, [isCrowFoot, state.loaded, state.doc, fitToDoc]);

  useEffect(() => {
    if (!state.justCreated || !state.selection.includes(state.justCreated)) return;
    showPanel('properties');
  }, [state.justCreated, showPanel]);

  useEffect(() => {
    if (!state.justCreated || openPanel !== 'properties' || !state.selection.includes(state.justCreated)) return;
    const frame = requestAnimationFrame(() => {
      const rect = svgRef.current?.getBoundingClientRect();
      const node = allNodes(shown).find((item) => item.id === state.justCreated);
      if (!rect || !node) return;
      const table = isCrowFoot ? deriveTables(shown).find((item) =>
        item.entityId === node.id || item.rows.some((row) => row.attributeId === node.id)) : null;
      if (isCrowFoot && !table) { fitToDoc(shown); return; }
      const rowIndex = table?.rows.findIndex((row) => row.attributeId === node.id) ?? -1;
      const dimensions = table ? { w: table.width, h: rowIndex < 0 ? tableHeight(table) : 44 } : sizeOf(state.doc, node.id);
      const x = table?.x ?? node.x;
      const y = table ? table.y + (rowIndex < 0 ? 0 : 44 + rowIndex * 44) : node.y;
      const area = canvasArea();
      if (!area) return;
      state.setViewport((current) => {
        // A shape created under the pointer is already on screen, and
        // re-centring on it yanked the canvas out from under the pointer that
        // had just placed it. Only move the view when the shape would otherwise
        // be off it — which is the case when it was created from the shape rail
        // with the pointer parked in a side panel.
        if (isVisibleIn(x, y, dimensions, area.width, area.height,
          { ...current, x: current.x - area.x, y: current.y - area.y })) return current;
        return {
          ...current,
          x: area.x + area.width / 2 - (x + dimensions.w / 2) * current.zoom,
          y: area.y + area.height / 2 - (y + dimensions.h / 2) * current.zoom,
        };
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [state.justCreated, openPanel, canvasArea, fitToDoc, state.doc, isCrowFoot]);

  useEffect(() => {
    if (!openPanel || !focusPanel.current) return;
    focusPanel.current = false;
    svgRef.current?.closest('.app')?.querySelector<HTMLElement>(
      '.workspace-panel[data-open="true"] :is(.rail, .outline, .inspector, .help-panel) :is(button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href])',
    )?.focus({ preventScroll: true });
  }, [openPanel]);

  useLayoutEffect(() => {
    if (!state.loaded || framed.current || isEmpty) return;
    framed.current = true;
    // A room-only link starts empty; frame its first incoming content. Local
    // creation keeps its pointer placement and has its own visibility check.
    if (!state.justCreated) fitToDoc(shown);
    // `shown`, not `state.doc`: framing has to follow the layout actually being
    // drawn, and in Crow's-foot that is this browser's own. `view` is here
    // because the two notations frame different drawings, and on a switch the
    // layout can be identical while the drawing is not.
  }, [state.loaded, state.doc, state.justCreated, isEmpty, fitToDoc, shown, state.view]);

  const zoomBy = (factor: number) => {
    framed.current = true;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    state.setViewport((current) => {
      const zoom = Math.max(0.25, Math.min(3, current.zoom * factor));
      const ratio = zoom / current.zoom;
      return { zoom, x: rect.width / 2 - (rect.width / 2 - current.x) * ratio,
        y: rect.height / 2 - (rect.height / 2 - current.y) * ratio };
    });
  };

  const addShape = useCallback((kind: ShapeKind, at?: { x: number; y: number }) => {
    if (!state.loaded) return;
    let view = state.view;
    let ownerId: string | null = null;
    if (kind === 'attribute') {
      // The first selected shape owns the attribute. With several selected,
      // the earliest in document order wins, so it does not depend on the order
      // the person happened to shift-click them in.
      const owner = state.selection[0];
      const attribute = state.doc.attributes.find((item) => item.id === owner);
      ownerId = attribute?.kind === 'composite' ? attribute.id : owner && [...state.doc.entities, ...state.doc.relationships, ...state.doc.isas]
        .some((item) => item.id === owner) ? owner : attribute?.ownerId ?? null;
      if (view === 'crowfoot' && !state.doc.entities.some((entity) => entity.id === ownerId)) view = 'chen';
    }
    if (kind === 'isa') view = 'chen';
    if (view !== state.view) state.setView(view);
    const rect = svgRef.current?.getBoundingClientRect();
    const size = view === 'crowfoot' && kind === 'entity' ? { w: CROW_WIDTH, h: 88 } :
      kind === 'attribute' ? { w: 130, h: 42 } : { w: 150, h: 72 };
    // Under the pointer when it is over the canvas, not always in the middle.
    // The context menu passes the exact point it was opened at.
    const origin = at
      ? { x: at.x - size.w / 2, y: at.y - size.h / 2 }
      : cursorOrigin(size, state.pointer.current, rect ?? null, state.viewport);
    const slot = findFreeSlot(occupiedBoxes({ ...shown, view }), origin, size);
    if (kind === 'attribute') state.addAttribute(slot.x, slot.y, ownerId);
    else if (kind === 'entity') state.addEntity(slot.x, slot.y, view === 'crowfoot' ? slot : undefined);
    else if (kind === 'relationship') {
      const id = state.addRelationship(slot.x, slot.y);
      if (view === 'chen') setConnectFrom(id);
    } else state.addIsa(slot.x, slot.y);
    showPanel('properties');
  }, [state, showPanel]);

  const tidy = useCallback(() => {
    checkpoint('Before Auto Arrange');
    setArrangeUndo(false);
    const arranged = applyLayout(shown);
    if (isCrowFoot) {
      // Tables are arranged in the Crow's-foot positions, so Tidy writes those
      // and leaves Chen's alone. Shared, so everybody sees the result.
      const before = new Map(shown.entities.map((entity) => [entity.id, entity]));
      const moved = new Map(arranged.entities
        .map((entity) => [entity.id, { x: entity.x, y: entity.y }] as const)
        .filter(([id, point]) => {
          const old = before.get(id);
          return old && (old.crowX !== point.x || old.crowY !== point.y);
        }));
      if (moved.size) { state.applyTablePositions(moved); setArrangeUndo(true); }
      fitToDoc({ ...arranged, entities: arranged.entities.map(entity => ({ ...entity, crowX: entity.x, crowY: entity.y })) });
      return;
    }
    const positions = new Map<string, { x: number; y: number }>();
    const before = new Map(allNodes(shown).map((node) => [node.id, node]));
    for (const node of allNodes(arranged)) {
      const old = before.get(node.id);
      if (old && (old.x !== node.x || old.y !== node.y)) positions.set(node.id, { x: node.x, y: node.y });
    }
    if (positions.size) { state.applyPositions(positions); setArrangeUndo(true); }
    fitToDoc(arranged);
  }, [state, fitToDoc, shown, isCrowFoot]);

  const focusShape = (id: string) => {
    let view = state.view;
    const attribute = state.doc.attributes.find((node) => node.id === id);
    const tables = deriveTables(shown);
    const table = tables.find((item) => item.entityId === id || item.rows.some((row) => row.attributeId === id));
    const link = deriveLinks(shown).find((item) => item.relId === id);
    if (view === 'crowfoot' && !table && !link) view = 'chen';
    if (view !== state.view) state.setView(view);
    select([id]);
    showPanel('properties');
    let node = allNodes(shown).find((item) => item.id === id);
    if (!node) {
      const leg = state.doc.legs.find((item) => item.id === id);
      node = allNodes(shown).find((item) => item.id === leg?.fromId);
    }
    let point = node ? { x: node.x + sizeOf(state.doc, node.id).w / 2, y: node.y + sizeOf(state.doc, node.id).h / 2 } : null;
    if (view === 'crowfoot' && table) {
      const row = table.rows.findIndex((item) => item.attributeId === id);
      point = { x: table.x + table.width / 2, y: table.y + (row < 0 ? tableHeight(table) / 2 : 44 + (row + 0.5) * 44) };
    }
    if (view === 'crowfoot' && link) {
      const a = tables.find((item) => item.entityId === link.fromEntityId)!;
      const b = tables.find((item) => item.entityId === link.toEntityId)!;
      point = placeRouteCaption(routeColumns(a, link.fromColumnId, b, link.toColumnId, link.lane, tables.map(tableObstacle),
        link.route, link.bend, link.routePoints), link.ratio);
    }
    if (point) requestAnimationFrame(() => {
      const area = canvasArea();
      if (!area) return;
      state.setViewport((current) => ({ ...current,
        x: area.x + area.width / 2 - point!.x * current.zoom, y: area.y + area.height / 2 - point!.y * current.zoom,
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
      /*
       * Import into the room you are already in.
       *
       * This used to mint a new room and navigate, which quietly left every
       * collaborator behind on the old one and made Back the only way back.
       * Importing is an edit, so it belongs to the room the edit happens in and
       * reaches everyone already there. Normalising here replaces what the old
       * path did by round-tripping the file through a share link — without it a
       * file missing whole collections would reach the model unchecked.
       */
      state.replaceDocument(normalizeDocument(result.doc));
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
          state.setTool('connect'); closePanel();
          break;
        case 'h': state.setTool('pan'); break;
        case 'f': event.preventDefault(); fitToView(); break;
        case 'delete': case 'backspace':
          if (state.selection.length > 0) { event.preventDefault(); state.remove(state.selection); }
          break;
        case 'i': event.preventDefault(); toggleFocus(); break;
        case 'escape':
          if (focusMode) { event.preventDefault(); toggleFocus(); }
          else { setConnectFrom(null); state.setSelection([]); closePanel(); }
          break;
        case '?': showPanel('help'); break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [state, isCrowFoot, addShape, fitToView, closePanel, showPanel, dialog, focusMode, toggleFocus]);

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

  /*
   * Who is here, and what they are looking at.
   *
   * The notation is each person's own choice, and a peer reading another
   * notation draws no cursor — so without this, a collaborator who cannot be
   * seen looks like a collaborator who is not there.
   */
  const peerSummary = state.peers.length === 0 ? 'Editing alone' :
    'Editing with ' + state.peers.map((peer) =>
      peer.name + ' (' + (peer.view === 'crowfoot' ? 'crow’s-foot' : 'Chen') + ')').join(', ');
  const connection = connectionState(state);
  const closeDialog = useCallback(() => setDialog(null), []);
  const closeMenu = useCallback(() => setMenu(null), []);
  const closeFileMenu = useCallback(() => setFileMenuAt(null), []);

  /**
   * Opens the right-click menu over whatever is under the pointer.
   *
   * Empty paper creates a shape there; a shape offers grouping. Which one it is
   * comes from the rendered target rather than from the current selection, because the
   * selection often outlives what was last clicked: right-clicking clear paper
   * while two shapes are selected has to offer creation, not offer to delete
   * something the pointer is nowhere near.
   */
  const openMenu = useCallback((event: React.MouseEvent | React.KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setFileMenuAt(null);
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || !state.loaded) return;
    const target = event.target instanceof Element ? event.target : null;
    const pointer = 'clientX' in event ? { x: event.clientX, y: event.clientY } : null;
    const keyboard = !pointer || (pointer.x === 0 && pointer.y === 0);
    let hit = target?.closest<HTMLElement | SVGElement>('[data-attribute-id], [data-node-id], [data-selection-id]');
    if (!hit && keyboard && state.selection[0]) {
      const id = CSS.escape(state.selection[0]);
      hit = svgRef.current?.querySelector<SVGElement>(
        `[data-attribute-id="${id}"], [data-node-id="${id}"], [data-selection-id="${id}"]`,
      ) ?? null;
    }
    const anchor = (hit ?? svgRef.current)?.getBoundingClientRect() ?? rect;
    const at = keyboard ? { x: anchor.left + anchor.width / 2, y: anchor.top + anchor.height / 2 } : pointer!;
    const world = {
      x: (at.x - rect.left - state.viewport.x) / state.viewport.zoom,
      y: (at.y - rect.top - state.viewport.y) / state.viewport.zoom,
    };
    const id = hit?.getAttribute('data-attribute-id') ?? hit?.getAttribute('data-node-id') ?? hit?.getAttribute('data-selection-id');
    // Right-clicking a shape you had not selected selects it, so the menu acts
    // on the thing under the pointer rather than on a stale selection.
    if (id && !state.selection.includes(id)) state.setSelection([id]);
    (hit ?? svgRef.current)?.focus({ preventScroll: true });
    setMenu({ at, world, shape: Boolean(id) });
  }, [state.loaded, state.viewport, state.selection, state.setSelection]);

  const menuItems: MenuItem[] | null = useMemo(() => {
    if (!menu) return null;
    if (menu.shape) {
      const selection = state.selection;
      const grouped = state.doc.groups.find((g) => selection.length > 0 && selection.every((id) => g.memberIds.includes(id)));
      const selectedRelationship = state.doc.relationships.find((r) => selection.length === 1 && selection[0] === r.id);
      const selectedEntity = state.doc.entities.find(entity => selection.length === 1 && selection[0] === entity.id);
      return [
        { label: 'Edit properties', onSelect: () => {
          select(selection);
          showPanel('properties');
          requestAnimationFrame(() => {
            const field = document.querySelector<HTMLInputElement | HTMLSelectElement>('.inspector input, .inspector select');
            field?.focus();
            if (field instanceof HTMLInputElement) field.select();
          });
        } },
        ...(selectedEntity ? [{ label: 'Add unary relationship', onSelect: () => {
          state.connect(selectedEntity.id, selectedEntity.id); showPanel('properties');
        } }] : []),
        { label: selection.length > 1 ? `Group ${selection.length} shapes` : 'Group selected shapes',
          separated: true, disabled: selection.length < 2 || Boolean(grouped),
          disabledReason: grouped ? 'These shapes are already grouped.' : 'Select at least two shapes with Shift-click to group them.',
          onSelect: () => state.group(selection) },
        ...(grouped ? [{ label: 'Remove group', onSelect: () => state.ungroup(grouped.id) }] : []),
        /*
         * Line routing, on the line's own menu.
         *
         * Every automatic rule about where a connector goes is a guess. The
         * corner can be dragged on the canvas; these are the three-way and
         * clear-it controls for anyone who would rather not drag, or who wants
         * the router to take over again.
         */
        ...(isCrowFoot && selectedRelationship ? [
          { label: 'Route line above', separated: true,
            disabled: selectedRelationship.route === 'above' && selectedRelationship.bendX === undefined && !selectedRelationship.routePoints,
            onSelect: () => state.updateRelationship(selectedRelationship.id, { route: 'above', bendX: undefined, bendY: undefined, routePoints: undefined }, true) },
          { label: 'Route line below',
            disabled: selectedRelationship.route === 'below' && selectedRelationship.bendX === undefined && !selectedRelationship.routePoints,
            onSelect: () => state.updateRelationship(selectedRelationship.id, { route: 'below', bendX: undefined, bendY: undefined, routePoints: undefined }, true) },
          { label: 'Route line automatically',
            disabled: (!selectedRelationship.route || selectedRelationship.route === 'auto') &&
              selectedRelationship.bendX === undefined && !selectedRelationship.routePoints,
            onSelect: () => state.updateRelationship(selectedRelationship.id, { route: 'auto', bendX: undefined, bendY: undefined, routePoints: undefined }, true) },
          { label: 'Clear manual route',
            disabled: selectedRelationship.bendX === undefined && selectedRelationship.bendY === undefined && !selectedRelationship.routePoints,
            disabledReason: 'This line has no manual route.',
            onSelect: () => state.updateRelationship(selectedRelationship.id, { bendX: undefined, bendY: undefined, routePoints: undefined }, true) },
        ] : []),
        { label: selection.length > 1 ? `Delete ${selection.length} shapes` : 'Delete selection',
          tone: 'danger' as const, separated: true, shortcut: 'Delete',
          onSelect: () => state.remove(selection) },
      ];
    }
    const create = (kind: ShapeKind, label: string, shortcut: string): MenuItem => ({
      label, shortcut, onSelect: () => addShape(kind, menu.world),
    });
    return [
      create('entity', 'New entity', 'E'),
      create('attribute', 'New attribute', 'A'),
      create('relationship', 'New relationship', 'R'),
      create('isa', 'New specialization', 'S'),
    ];
  }, [menu, state.selection, state.doc.groups, state.doc.relationships, state.updateRelationship, isCrowFoot, state.group, state.ungroup, state.remove, addShape, select, showPanel]);
  const fileItems: MenuItem[] = [
    { label: 'New', onSelect: () => openDocument(emptyDocument()) },
    { label: 'Import', onSelect: () => fileInputRef.current?.click() },
    { label: 'Open an example', onSelect: () => setDialog('examples') },
    { label: 'Export', separated: true, onSelect: () => setDialog('export') },
    { label: 'Share', onSelect: () => setDialog('share') },
    // Theme is a setting about this app, not about modeling, so it lives here
    // rather than at the bottom of a long Help scroll.
    { label: `Theme: ${THEMES.find((t) => t.id === savedTheme())?.name ?? 'System'}`,
      separated: true, onSelect: () => setDialog('theme') },
    { label: 'Help', onSelect: () => showPanel('help') },
    // Your name used to be reachable only on an empty canvas, which meant it
    // could not be changed once you had drawn anything.
    { label: `Your name: ${state.identity.name}`, separated: true, onSelect: () => setDialog('name') },
  ];
  const emptyActions = isEmpty ? <>
    <div className="starter-name">
      <label className="field__label" htmlFor="start-name">Your name</label>
      <input
        id="start-name"
        className="field__input"
        value={nameDraft}
        onChange={(event) => {
          setNameDraft(event.target.value);
          state.setIdentityName(event.target.value);
        }}
        // Blurring puts back the last name that was actually committed, so
        // emptying the field to retype it does not leave a nameless person.
        onBlur={() => setNameDraft(state.identity.name)}
        placeholder="Your name"
        autoComplete="off"
        maxLength={32}
      />
      <p className="field__help">Collaborators see this beside your cursor. It stays in this browser.</p>
    </div>
    <div className="starter-actions">
      <button type="button" className="btn btn--primary" disabled={!state.loaded} onClick={() => addShape('entity')}>Add your first entity</button>
      <button type="button" className="btn" onClick={() => setDialog('examples')}>Open an example</button>
    </div>
  </> : null;

  /*
   * A short link carries no diagram, so an empty canvas after following one is
   * a *waiting* state, not a blank page. Showing "start with an entity" there is
   * the worst possible answer: the joiner starts drawing a schema that the
   * incoming document will replace, or believes their link is broken and
   * re-sends it. The room id is in the message because telling somebody "ask
   * them to reopen it" is only actionable if they can identify which room.
   */
  const waitingForPeer = fromLink && !seed && isEmpty && state.loaded && state.peers.length === 0;
  const emptyState = waitingForPeer ? (
    <div className="canvas-empty">
      <div className="canvas-empty__card">
        <h2 className="canvas-empty__title">Waiting for the diagram</h2>
        <p className="canvas-empty__body">
          This link opens a live room rather than a copy, so the diagram appears as soon as the
          person who shared it connects. Their tab needs to be open.
        </p>
        {/* Not `.canvas-empty__hint`: that is hidden on phones, and a phone is
            exactly where a second person opens a shared link. */}
        <p className="canvas-empty__body">
          Room <code>{state.room}</code>. If that tab is closed, ask them to share the link again
          from Share — a link made there carries the diagram and opens with nobody online.

           Nothing is loading because this room has no diagram on the server yet: ask the sharer to
           open the live site with that diagram and use Share → Copy link.
         </p>
      </div>
    </div>
  ) : null;

  return (
    <div className="app" data-keyboard={keyboardOpen} data-focus={focusMode}>
      <a className="skip-link" href="#canvas-region" onClick={(event) => { event.preventDefault(); svgRef.current?.focus(); }}>Skip to the canvas</a>
      <header className="topbar">
        <h1 className="visually-hidden">ERD Maker</h1>
        <button ref={fileMenuTrigger} type="button" className="btn btn--ghost icon-control" aria-label="Diagram actions"
          title="Diagram actions" aria-haspopup="menu" aria-expanded={Boolean(fileMenuAt)}
          onClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            setMenu(null);
            setFileMenuAt(fileMenuAt ? null : { x: bounds.left, y: bounds.bottom + 8 });
          }}><WorkspaceIcon name="menu" /></button>
        <div className="document-title">
          <label className="visually-hidden" htmlFor="doc-name">Diagram name</label>
          <input id="doc-name" className="docname" value={state.doc.name} disabled={!state.loaded}
            onChange={(event) => state.setDocName(event.target.value)} placeholder="Untitled diagram" autoComplete="off" />
          <span className="storage-label visually-hidden">{state.loaded ? 'Saves in this browser' : 'Opening diagram…'}</span>
        </div>
        <div className="seg notation" role="group" aria-label="Notation">
          {(['chen', 'crowfoot'] as const).map((view) => <button key={view} type="button" className="seg__btn" aria-pressed={state.view === view}
            onClick={() => {
              state.setView(view);
              // Reframe through the one effect that knows about this browser's
              // Crow's-foot layout. Fitting the shared document here would put
              // the new view where the *other* notation had its shapes, and
              // could land it under an open panel.
              framed.current = false;
            }}>{view === 'chen' ? 'Chen' : "Crow's-foot"}</button>)}
        </div>
        <span className="topbar__spacer" />
        {/*
          The room connection, where a person can see it.

          The status bar carries the same news for screen readers, but it is
          hidden: somebody who opened one room on two devices and sees nothing
          happen has to be able to tell a quiet room from a blocked one, and
          that answer cannot be something only a screen reader gets.
        */}
        <span className="connection-pill" data-state={connection.state} title={connection.note}>
          <span className="connection-pill__dot" aria-hidden="true" />
          {connection.label}
        </span>
        {connection.fix ? <button type="button" className="btn btn--ghost connection-fix"
          onClick={() => setDialog('share')}>Share a snapshot</button> : null}
        {state.peers.length > 0 ? <div className="presence" title={peerSummary} aria-label={peerSummary}>
          {state.peers.slice(0, 3).map((peer) => <span key={peer.clientId} className="presence__avatar" title={peer.name}
            style={{ background: peer.color, color: presenceInk(peer.color) }}>{initials(peer.name)}</span>)}
        </div> : null}
        <div className="file-actions">
          <button type="button" className="btn btn--ghost icon-control header-export" aria-label="Export"
            title="Export diagram" onClick={() => setDialog('export')}><WorkspaceIcon name="export" /></button>
          <button type="button" className="btn btn--ghost header-share" onClick={() => setDialog('share')}>Share</button>
          <button type="button" className="btn btn--ghost icon-control" aria-label="Enter Focus view"
            title="Focus view (I)" aria-keyshortcuts="I" onClick={toggleFocus}><WorkspaceIcon name="focus" /></button>
        </div>
        <input ref={fileInputRef} type="file" accept="application/json,.json" className="visually-hidden"
          onChange={(event) => { const file = event.target.files?.[0]; if (file) void onImportFile(file); event.target.value = ''; }}
          tabIndex={-1} aria-hidden="true" />
      </header>

      <div className="editor-toolbar" role="toolbar" aria-label="Diagram tools">
        <div className="history-tools">
          <button type="button" className="btn btn--ghost icon-control" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!state.canUndo} onClick={state.undo}>↶</button>
          <button type="button" className="btn btn--ghost icon-control" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!state.canRedo} onClick={state.redo}>↷</button>
          <button type="button" className="btn btn--ghost" onClick={() => { setVersions(readVersions(state.room)); setVersionsOpen(!versionsOpen); }}>Versions</button>
        </div>
        <div className="drawing-tools">
          <button type="button" className="btn btn--ghost tool-btn icon-control" aria-label="Select tool" title="Select (V)" aria-pressed={state.tool === 'select'} onClick={() => state.setTool('select')}><WorkspaceIcon name="select" /></button>
          <button type="button" className="btn btn--ghost tool-btn icon-control" aria-label="Connect tool"
            title={isCrowFoot ? 'Connect two attribute rows (C)' : 'Connect two entities to create a relationship (C)'}
            aria-pressed={state.tool === 'connect'} onClick={() => { state.setTool('connect'); closePanel(); }}><WorkspaceIcon name="connect" /></button>
          <button type="button" className="btn btn--ghost tool-btn icon-control" aria-label="Pan tool" title="Pan (H)" aria-pressed={state.tool === 'pan'} onClick={() => { state.setTool('pan'); closePanel(); }}><WorkspaceIcon name="pan" /></button>
        </div>
        <button type="button" className="btn btn--ghost arrange-btn icon-control" aria-label="Auto-arrange" onClick={tidy} title="Auto-arrange"><WorkspaceIcon name="arrange" /></button>
        {arrangeUndo && <button type="button" className="btn btn--ghost" title="Undo the latest edit; immediately after arranging, restores the previous layout" disabled={!state.canUndo} onClick={() => { state.undo(); setArrangeUndo(false); }}>Undo</button>}
      </div>
      {versionsOpen && <Modal title="Versions" onClose={() => setVersionsOpen(false)}>
        <p>Last 20 versions, saved in this browser. A version is saved before each Auto Arrange.</p>
        <form onSubmit={event => {
          event.preventDefault();
          const name = versionName.trim() || 'Manual save';
          checkpoint(name);
        }}>
          <label htmlFor="version-name">Version name</label>
          <input id="version-name" value={versionName} maxLength={100}
            placeholder="Name this snapshot (e.g. Before regroup)" autoFocus
            onChange={event => setVersionName(event.target.value)} />
          <button type="submit" className="btn" disabled={!versionName.trim()}>Save version</button>
        </form>
        <button type="button" className="btn btn--ghost" onClick={() => setVersionsOpen(false)}>Close</button>
        <ul>{versions.map(version => <li key={version.id}>
          <strong>{version.label}</strong> · {new Date(version.date).toLocaleString()}{' '}
          <button type="button" className="btn btn--ghost" onClick={() => {
            if (!window.confirm('Restore this version? Your current diagram will be saved first. This also changes the shared diagram.')) return;
            try { setVersions(saveVersion(state.room, state.doc, 'Before restore')); }
            catch { setError('Could not save the current diagram. Restore cancelled.'); return; }
            state.replaceDocument(version.doc);
            fitToDoc(version.doc);
            setArrangeUndo(false);
          }}>Restore</button>
          <button type="button" className="btn btn--ghost" onClick={() => {
            if (!window.confirm('Delete this version?')) return;
            setVersions(deleteVersion(state.room, version.id));
          }}>Delete</button>
        </li>)}</ul>
        {!versions.length && <p>No saved versions yet.</p>}
      </Modal>}

      <div className="workspace" id="canvas-region">
        <div className="workspace-panel workspace-panel--left" data-open={openPanel === 'build' || openPanel === 'diagram'}>
          <div className="panel-header">
            <div className="seg" role="group" aria-label="Left panel">
              <button type="button" className="seg__btn" aria-pressed={leftTab === 'build'} onClick={() => { setLeftTab('build'); setOpenPanel('build'); }}>Build</button>
              <button type="button" className="seg__btn" aria-pressed={leftTab === 'diagram'} onClick={() => { setLeftTab('diagram'); setOpenPanel('diagram'); }}>Diagram</button>
            </div>
            <button type="button" className="btn btn--ghost panel-close" aria-label="Close panel" onClick={closePanel}><span className="panel-close--desktop">×</span><span className="panel-close--phone">Done</span></button>
          </div>
          {leftTab === 'build' ? <ShapeRail state={editor} onAdd={addShape} onExamples={() => setDialog('examples')} /> :
            <DiagramOutline state={editor} onSelect={focusShape} />}
        </div>

        <div className="canvas-stage" onContextMenu={openMenu} onDoubleClick={revealProperties} onKeyDown={(event) => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) openMenu(event);
        }}>
          {isCrowFoot ? <CrowFootCanvas state={editor} svgRef={svgRef} emptyActions={emptyActions} emptyState={emptyState} onTablePositions={state.applyTablePositions} /> :
            <ChenCanvas state={editor} svgRef={svgRef} connectFrom={connectFrom} setConnectFrom={setConnectFrom} emptyActions={emptyActions} emptyState={emptyState} />}
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
            <button type="button" className="btn btn--ghost panel-close" aria-label="Close panel" onClick={closePanel}><span className="panel-close--desktop">×</span><span className="panel-close--phone">Done</span></button>
          </div>
          {rightTab === 'help' ? <HelpPanel /> : <Inspector state={editor} nameFocusReady={openPanel === 'properties'} />}
        </div>
      </div>

      <footer className="statusbar visually-hidden">
        <span className="diagram-counts">{state.doc.entities.length} entities · {state.doc.relationships.length} relationships · {state.doc.attributes.length} attributes</span>
        <span className="statusbar__spacer" />
        <span className="collaboration-status">{peerSummary}{state.directPeers > 0 ? import.meta.env.VITE_SYNC_URL ? ' · Cloud sync' : ' · Direct connection' : state.connected ? ' · Same browser' : ''} · {connection.note}</span>
      </footer>
      {connectFrom ? <div className="connection-guidance" role="status">Pick a shape to connect <button type="button" className="btn btn--ghost" onClick={() => setConnectFrom(null)}>Cancel</button></div> : null}
      <nav className="panel-navigation" aria-label="Workspace panels">
        {(['build', 'diagram', 'properties', 'help'] as const).map((panel) => <button key={panel} type="button" className="btn btn--ghost"
          aria-label={panel.charAt(0).toUpperCase() + panel.slice(1)} title={panel.charAt(0).toUpperCase() + panel.slice(1)}
          aria-expanded={openPanel === panel} onClick={(event) => openPanel === panel ? closePanel() : showPanel(panel, event.currentTarget, event.detail === 0)}>
          <WorkspaceIcon name={panel} />
          <span className="panel-navigation__label">{panel === 'build' ? 'Add' : panel === 'properties' ? 'Edit' : panel.charAt(0).toUpperCase() + panel.slice(1)}</span>
        </button>)}
      </nav>
      {focusMode ? <button type="button" className="btn btn--ghost focus-exit" aria-label="Exit Focus view"
        title="Exit Focus view (Esc or I)" onClick={toggleFocus}><WorkspaceIcon name="focus" /><span>Exit Focus view</span></button> : null}

      {error ? <div className="feedback feedback--error" role="alert"><span>{error}</span><button type="button" className="btn btn--ghost" onClick={() => setError(null)}>Dismiss</button></div> : null}
      {state.notice ? <div className="feedback" role="status"><span>{state.notice}</span>
        {state.notice.endsWith(' deleted.') ? <button type="button" className="btn" disabled={!state.canUndo} onClick={state.undo}>Undo</button> : null}
        <button type="button" className="btn btn--ghost" aria-label="Dismiss notification" onClick={state.clearNotice}>×</button></div> : null}
      {dialog === 'share' ? <ShareDialog state={editor} onClose={closeDialog} /> : null}
      {dialog === 'export' ? <ExportDialog state={editor} svgRef={svgRef} onClose={closeDialog} /> : null}
      {dialog === 'examples' ? <ExamplesDialog onOpen={openDocument} onClose={closeDialog} /> : null}
      {dialog === 'theme' ? (
        <Modal title="Theme" onClose={closeDialog}>
          <ThemePicker />
        </Modal>
      ) : null}
      {dialog === 'name' ? (
        <Modal title="Your name" onClose={closeDialog}>
          <NameField state={state} />
        </Modal>
      ) : null}
      {menu && menuItems ? (
        <ContextMenu at={menu.at} items={menuItems} label={menu.shape ? 'Shape actions' : 'Add a shape'} onClose={closeMenu} />
      ) : null}
      {fileMenuAt ? <ContextMenu at={fileMenuAt} items={fileItems} label="Diagram actions" onClose={closeFileMenu} trigger={fileMenuTrigger} /> : null}
    </div>
  );
}

/**
 * Your own name, editable at any point.
 *
 * The same control as the empty-canvas card, because it was only reachable
 * there: once the canvas had content there was no way to change it at all.
 *
 * Clearing the field does not commit an empty name — `setIdentityName` refuses
 * one, so a peer is never shown nameless — but the text stays editable while
 * empty so the name can be retyped, and blur restores what was last committed.
 */
function NameField({ state }: { state: EditorState }) {
  const [draft, setDraft] = useState(state.identity.name);
  return (
    <div className="field">
      <label className="field__label" htmlFor="dialog-name">Your name</label>
      <input
        id="dialog-name"
        className="field__input"
        value={draft}
        autoComplete="off"
        maxLength={32}
        onChange={(event) => {
          setDraft(event.target.value);
          state.setIdentityName(event.target.value);
        }}
        onBlur={() => setDraft(state.identity.name)}
      />
      <p className="field__help">Collaborators see this beside your cursor. It stays in this browser.</p>
    </div>
  );
}

function initials(name: string): string {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?';
}

/**
 * What to say about the room connection.
 *
 * Two different failures look identical from inside the room: nobody is here,
 * or the network will not let the room be reached. The signalling server finds
 * people in other devices and the direct connection carries the edits, and
 * either can fail on its own, so the status says which one it is and what to
 * do about it.
 */
function connectionState(state: EditorState): { state: string; label: string; note: string; fix: boolean } {
  if (import.meta.env.VITE_SYNC_URL) {
    if (!state.transport.signalling) return { state: 'offline', label: 'Reconnecting', fix: true,
      note: 'Reconnecting to cloud sync. Your edits stay saved in this browser.' };
    return { state: 'live', label: state.peers.length ? 'Live' : 'Connected', fix: false,
      note: state.peers.length ? 'Connected to cloud sync with collaborators.' : 'Connected to cloud sync. Share this room link to invite collaborators.' };
  }
  if (state.transport.direct > 0) {
    return { state: 'live', label: 'Live', fix: false,
      note: 'Live edits are flowing between the browsers in this room.' };
  }
  if (state.peers.length > 0) {
    return { state: 'local', label: 'Same browser', fix: false,
      note: 'The other people here are in this browser. A device elsewhere cannot see them.' };
  }
  if (state.transport.blocked > 0) {
    return { state: 'blocked', label: 'Blocked', fix: true,
      note: 'Your peer was found, but the network between the two browsers refused the connection. Share a snapshot link instead.' };
  }
  if (!state.transport.signalling) {
    return { state: 'offline', label: 'Offline', fix: true,
      note: 'The signalling server cannot be reached, so people in other devices cannot be found. Share a snapshot link instead.' };
  }
  return { state: 'waiting', label: 'Waiting', fix: false,
    note: 'Nobody else is in this room yet. Share the room link to bring somebody in.' };
}

export { PRESENCE_COLORS };
