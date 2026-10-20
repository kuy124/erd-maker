/**
 * Application state.
 *
 * One hook owns the whole editor: the Yjs room, the materialised document, the
 * selection, the viewport, and the derived peers. Components stay presentational
 * and read from here, which keeps the mutation paths in a single auditable
 * place — important when two of those paths are "a remote peer changed
 * something" and "I dragged a shape".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { connectedPeerCount, onTransport, readPeers, transportState, type PeerState, type RoomHandle, type TransportState } from '../collab/provider';
import { createLocalIdentity, rememberIdentity, type Identity } from '../collab/identity';
import {
  connectColumns,
  connectNodes,
  deleteGroupFromYdoc,
  deleteNodeFromYdoc,
  seedDocument,
  setGroupMembers,
  setMeta,
  setCrowPlacement,
  snapshotFromYdoc,
  upsertAttribute,
  upsertEntity,
  upsertIsa,
  upsertRelationship,
} from '../collab/ydoc';
import { writeParticipants, type RelationshipParticipant } from '../collab/participants';
import { validParticipation } from '../model/issues';
import { findAttributeSlot } from '../model/placement';
import { emptyDocument, ROUTE_SIDES, type EntityKind, type ErdDocument, type RouteSide } from '../model/types';
import type { ColumnEndpoint } from '../model/crowfoot';
import { normalizeDataType, type DataType } from '../model/dataTypes';
import { canOwnAttribute } from '../model/attributes';
import { normalizeRoutePoints, type RoutePoint } from '../model/connectorRouting';

export type Tool = 'select' | 'pan' | 'connect';

export interface Viewport {
  /** Pan offset in screen pixels. */
  x: number;
  y: number;
  /** Zoom factor, 1 = 100%. */
  zoom: number;
}

export interface EditorState {
  room: string;
  identity: Identity;
  /** Renames you for other collaborators, and remembers it in this browser. */
  setIdentityName: (name: string) => void;
  doc: ErdDocument;
  view: ErdDocument['view'];
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  notice: string | null;
  clearNotice: () => void;
  peers: PeerState[];
  connected: boolean;
  /** Peers reachable over a direct WebRTC connection (not just same-browser). */
  directPeers: number;
  /**
   * What the room connection is doing, and why nobody may be there.
   *
   * The signalling server is what finds a peer in another device; the direct
   * connection is what carries the edits. Either can fail on its own, and the
   * person waiting in the room can only be helped if they are told which.
   */
  transport: TransportState;
  loaded: boolean;
  /**
   * Ids of every selected node. Empty means nothing is selected.
   *
   * An array rather than a single id because selection is a set in every other
   * editor people already use, and because almost everything worth doing with a
   * selection — drag it, delete it, group it — only makes sense for more than
   * one. Order is document order, so the inspector reads the same way every time.
   */
  selection: string[];
  /**
   * Latest pointer position in client coordinates, or null when the pointer is
   * not over the window.
   *
   * A ref rather than state: it updates on every pointer move and is read only
   * when a creation shortcut fires, so state here would re-render the editor
   * continuously for no visible benefit.
   */
  pointer: React.MutableRefObject<{ x: number; y: number } | null>;
  /**
   * The shape created by the most recent add, or null. The inspector focuses
   * its name field for this one, so a new shape can be named straight away
   * without clicking into the panel.
   */
  justCreated: string | null;
  viewport: Viewport;
  tool: Tool;
  setTool: (tool: Tool) => void;
  setSelection: (ids: string[]) => void;
  /** Adds or removes one id, for shift-click. */
  toggleSelection: (id: string) => void;
  setViewport: (updater: (v: Viewport) => Viewport) => void;
  setDocName: (name: string) => void;
  setView: (view: 'chen' | 'crowfoot') => void;
  updateEntity: (id: string, patch: Partial<{ name: string; x: number; y: number; kind: EntityKind }>) => void;
  updateAttribute: (id: string, patch: Partial<{ name: string; x: number; y: number; kind: string; ownerId: string | null; dataType: DataType }>) => void;
  updateRelationship: (id: string, patch: Partial<{ name: string; x: number; y: number; kind: 'strong' | 'weak'; route: RouteSide; bendX: number | undefined; bendY: number | undefined; routePoints: RoutePoint[] | undefined }>, separateUndo?: boolean) => void;
  updateLeg: (id: string, patch: Partial<{ cardinality: '1' | 'N' | 'M'; min: number; max: number | 'N' }>) => void;
  setParticipants: (relationshipId: string, participants: RelationshipParticipant[]) => void;
  updateIsaParent: (id: string, parentId: string | null) => void;
  updateIsaChildren: (id: string, childId: string, included: boolean) => void;
  addEntity: (x: number, y: number, crowPosition?: { x: number; y: number }) => string;
  addAttribute: (x: number, y: number, ownerId?: string | null) => string;
  addRelationship: (x: number, y: number) => string;
  addIsa: (x: number, y: number) => string;
  connect: (fromId: string, toId: string) => string | null;
  connectColumns: (from: ColumnEndpoint, to: ColumnEndpoint) => string | null;
  remove: (ids: string[]) => void;
  /**
   * Puts every selected shape into one group, or dissolves it when `ids` is
   * empty. Returns the group id, or null when there was nothing to group.
   */
  group: (ids: string[], name?: string) => string | null;
  /** Removes a group, leaving its members exactly where they are. */
  ungroup: (id: string) => void;
  replaceDocument: (doc: ErdDocument) => void;
  applyPositions: (positions: Map<string, { x: number; y: number }>) => void;
  /** Moves Crow's-foot tables, writing the shared position that Chen does not use. */
  applyTablePositions: (positions: Map<string, { x: number; y: number }>) => void;
  /** Places tables the person did not move. Not undoable; see the implementation. */
  placeTables: (positions: Map<string, { x: number; y: number }>) => void;
  ydoc: Y.Doc;
  awareness: RoomHandle['awareness'];
}

let counter = 0;
/** Short unique id. Prefixed by kind so debugging a document is readable. */
function makeId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}

function savedView(room: string): ErdDocument['view'] | null {
  try {
    const value = localStorage.getItem('erd:view:' + room);
    return value === 'chen' || value === 'crowfoot' ? value : null;
  } catch {
    return null;
  }
}

export function useEditor(room: RoomHandle, initialDoc: ErdDocument | null): EditorState {
  const [doc, setDoc] = useState<ErdDocument>(() => initialDoc ?? emptyDocument());
  const [view, setLocalView] = useState<ErdDocument['view']>(() => savedView(room.room) ?? initialDoc?.view ?? 'chen');
  const [notice, setNotice] = useState<string | null>(null);
  const undoRef = useRef<Y.UndoManager | null>(null);
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  const [loaded, setLoaded] = useState(false);
  const [peers, setPeers] = useState<PeerState[]>([]);
  const [connected, setConnected] = useState(false);
  const [directPeers, setDirectPeers] = useState(0);
  const [transport, setTransport] = useState<TransportState>({ signalling: false, direct: 0, blocked: 0 });
  const [selection, setSelection] = useState<string[]>([]);
  /**
   * The id of the shape created by the most recent add, or null.
   *
   * Tracked separately from `selection` because they are not the same thing: a
   * shape being selected is not a reason to pull focus into the inspector, but
   * a shape having just been created is, so its name can be typed straight away.
   */
  const [justCreated, setJustCreated] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [identity, setIdentity] = useState<Identity>(() => createLocalIdentity(room.ydoc.clientID));
  const visibleDoc = useMemo(() => ({ ...doc, view }), [doc, view]);

  // Seed the shared document from the share link, but only if it is empty —
  // otherwise a late joiner would overwrite a room that already has work in it.
  useEffect(() => {
    let cancelled = false;
    void room.whenLoaded.then(() => {
      if (cancelled) return;
      const hasDocument = room.ydoc.getMap('meta').has('name') ||
        ['entities', 'attributes', 'relationships', 'isas'].some((key) => room.ydoc.getMap(key).size > 0);
      if (initialDoc && !hasDocument) seedDocument(room.ydoc, initialDoc);
      if (!initialDoc && !savedView(room.room)) setLocalView(snapshotFromYdoc(room.ydoc).view);
      undoRef.current?.clear();
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [room, initialDoc]);

  useEffect(() => {
    const manager = new Y.UndoManager(
      ['entities', 'attributes', 'relationships', 'isas', 'legs', 'groups', 'meta']
        .map((key) => room.ydoc.getMap(key)),
      { captureTimeout: 400 },
    );
    undoRef.current = manager;
    const update = () => setHistory({ canUndo: manager.canUndo(), canRedo: manager.canRedo() });
    manager.on('stack-item-added', update);
    manager.on('stack-item-popped', update);
    manager.on('stack-cleared', update);
    update();
    return () => { manager.destroy(); undoRef.current = null; };
  }, [room]);

  // Materialise the document whenever Yjs changes, including remote edits.
  useEffect(() => {
    const sync = () => setDoc(snapshotFromYdoc(room.ydoc));
    sync();
    room.ydoc.on('update', sync);
    return () => {
      room.ydoc.off('update', sync);
    };
  }, [room]);

  // Presence: names, colours, cursors, and selection outlines. Awareness is
  // also the honest source of truth for "is anyone else here": it is populated
  // over whichever transport connected (WebRTC or BroadcastChannel), whereas
  // the provider's own events only describe WebRTC.
  useEffect(() => {
    const { awareness } = room;
    const update = () => {
      const states = awareness.getStates();
      setPeers(readPeers(awareness, room.ydoc.clientID));
      setConnected(states.size > 1);
    };
    awareness.on('change', update);
    update();
    return () => {
      awareness.off('change', update);
    };
  }, [room]);

  // Publish our own identity and selection into awareness.
  useEffect(() => {
    room.awareness.setLocalStateField('name', identity.name);
    room.awareness.setLocalStateField('color', identity.color);
  }, [room, identity]);

  // Publish our own selection into awareness. Joining on a key rather than
  // replacing the value means an unrelated awareness change (a peer moving)
  // does not re-send the same selection.
  useEffect(() => {
    room.awareness.setLocalStateField('selectedIds', selection);
  }, [room, selection]);

  // Publish which notation we are looking at, so a peer's cursor is only drawn
  // for somebody reading the same drawing. The two notations place one schema at
  // different coordinates, so an arrow from the other one points at nothing.
  useEffect(() => {
    room.awareness.setLocalStateField('view', view);
  }, [room, view]);

  // Track whether the WebRTC transport actually has peers. This is a second
  // signal on top of awareness: awareness can be populated by BroadcastChannel
  // alone, so the provider's own peer events are what tell us a cross-device
  // connection exists.
  useEffect(() => {
    const provider = room.provider;
    const update = () => {
      setDirectPeers(connectedPeerCount(provider));
      setTransport(transportState(provider));
    };
    provider.on('peers', update);
    provider.on('status', update);
    const stopTransport = onTransport(provider, update);
    // The signalling socket has a life of its own: it drops and reconnects on
    // its own, and whether it is up is the difference between "nobody is in
    // this room" and "this room cannot be found".
    for (const conn of provider.signalingConns) {
      conn.on('connect', update);
      conn.on('disconnect', update);
    }
    update();
    return () => {
      provider.off('peers', update);
      provider.off('status', update);
      stopTransport();
    };
  }, [room]);

  // Drop ids that a collaborator deleted, rather than leaving the selection
  // pointing at shapes that are no longer there.
  useEffect(() => {
    if (selection.length === 0) return;
    const present = new Set(
      [...doc.entities, ...doc.attributes, ...doc.relationships, ...doc.isas, ...doc.legs]
        .map((node) => node.id),
    );
    const kept = selection.filter((id) => present.has(id));
    if (kept.length !== selection.length) setSelection(kept);
  }, [doc, selection]);

  const mutate = useCallback(
    (fn: () => void, separate = false) => {
      if (separate) undoRef.current?.stopCapturing();
      room.ydoc.transact(fn);
      if (separate) undoRef.current?.stopCapturing();
    },
    [room],
  );

  const api = useMemo<Omit<EditorState, 'doc' | 'view' | 'canUndo' | 'canRedo' | 'notice' | 'peers' | 'connected' | 'directPeers' | 'transport' | 'loaded' | 'room' | 'identity' | 'selection' | 'pointer' | 'justCreated' | 'viewport' | 'tool' | 'ydoc' | 'awareness'>>(() => ({
    setTool,    setSelection: (ids) => { setSelection(ids); setJustCreated(null); },
    toggleSelection: (id) => setSelection((current) =>
      current.includes(id) ? current.filter((other) => other !== id) : [...current, id]),
    setViewport,
    setDocName: (name: string) => setMeta(room.ydoc, { name }),
    setView: (next) => {
      setLocalView(next);
      setTool('select');
      try { localStorage.setItem('erd:view:' + room.room, next); } catch { /* Editing works without preferences. */ }
    },
    undo: () => { undoRef.current?.undo(); setNotice(null); },
    redo: () => { undoRef.current?.redo(); setNotice(null); },
    clearNotice: () => setNotice(null),

    updateEntity: (id, patch) =>
      mutate(() => {
        const map = room.ydoc.getMap('entities').get(id) as Y.Map<unknown> | undefined;
        if (!map) return;
        for (const [key, value] of Object.entries(patch)) map.set(key, value as never);
      }),

    updateAttribute: (id, patch) =>
      mutate(() => {
        const live = snapshotFromYdoc(room.ydoc);
        if (patch.ownerId !== undefined && !canOwnAttribute(live, id, patch.ownerId)) {
          setNotice('Choose an entity, relationship, specialization or composite outside this attribute’s parts.');
          return;
        }
        if (patch.kind && patch.kind !== 'composite' && live.attributes.some(a => a.ownerId === id)) {
          setNotice('Move or delete the parts before changing this composite’s kind.');
          return;
        }
        const map = room.ydoc.getMap('attributes').get(id) as Y.Map<unknown> | undefined;
        if (!map) return;
        for (const [key, value] of Object.entries(patch)) {
          if (key === 'dataType') {
            const dataType = normalizeDataType(value);
            if (dataType) map.set(key, dataType);
            else map.delete(key);
          } else map.set(key, value as never);
        }
      }),

    updateRelationship: (id, patch, separateUndo = false) =>
      mutate(() => {
        const map = room.ydoc.getMap('relationships').get(id) as Y.Map<unknown> | undefined;
        if (!map) return;
        for (const [key, value] of Object.entries(patch)) {
          // A route that is not one of the three has no meaning, and writing it
          // would leave the connector falling back to automatic anyway — but as
          // a stored value nobody can see or undo.
          if (key === 'route' && !ROUTE_SIDES.includes(value as RouteSide)) continue;
          if (key === 'routePoints') {
            if (value === undefined) map.delete(key);
            else {
              const points = normalizeRoutePoints(value);
              if (points) map.set(key, points);
            }
            continue;
          }
          // A corner is two finite numbers or nothing. `undefined` clears the
          // half, which is how dragging back to automatic works.
          if ((key === 'bendX' || key === 'bendY')) {
            if (value === undefined) { map.delete(key); continue; }
            if (typeof value !== 'number' || !Number.isFinite(value)) continue;
          }
          map.set(key, value as never);
        }
      }, separateUndo),

    updateLeg: (id, patch) =>
      mutate(() => {
        const map = room.ydoc.getMap('legs').get(id) as Y.Map<unknown> | undefined;
        if (!map) return;
        const min = patch.min ?? (patch.cardinality === '1' ? Math.min(1, Number(map.get('min') ?? 0)) : Number(map.get('min') ?? 0));
        const max = patch.max ?? (patch.cardinality ? (patch.cardinality === '1' ? 1 : 'N') :
          (map.get('max') as number | 'N' | undefined) ?? 1);
        if (!validParticipation(min, max)) return;
        const cardinality = patch.cardinality ?? (patch.max !== undefined ?
          (max === 1 ? '1' : map.get('cardinality') === 'M' ? 'M' : 'N') : map.get('cardinality'));
        if (map.get('cardinality') !== cardinality) map.set('cardinality', cardinality);
        if (map.get('min') !== min) map.set('min', min);
        if (map.get('max') !== max) map.set('max', max);
      }),

    setParticipants: (relationshipId, participants) => {
      try {
        mutate(() => writeParticipants(room.ydoc, relationshipId, participants, () => makeId('leg')), true);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'Could not update the participants.');
      }
    },

    updateIsaParent: (id, parentId) =>
      mutate(() => {
        const map = room.ydoc.getMap('isas').get(id) as Y.Map<unknown> | undefined;
        if (map) map.set('parentId', parentId);
      }),

    updateIsaChildren: (id, childId, included) =>
      mutate(() => {
        const map = room.ydoc.getMap('isas').get(id) as Y.Map<unknown> | undefined;
        if (!map) return;
        const current = map.get('childIds');
        const list = Array.isArray(current) ? current.filter((c): c is string => typeof c === 'string') : [];
        const next = included
          ? list.includes(childId)
            ? list
            : [...list, childId]
          : list.filter((c) => c !== childId);
        map.set('childIds', next);
      }),

    addEntity: (x, y, crowPosition) => {
      const id = makeId('ent');
      mutate(() => upsertEntity(room.ydoc, { id, name: 'New entity', x, y, kind: 'strong',
        ...(crowPosition ? { crowX: crowPosition.x, crowY: crowPosition.y } : {}) }), true);
      setSelection([id]);
      setJustCreated(id);
      return id;
    },

    /**
     * Adds an attribute.
     *
     * When `ownerId` is given, the attribute is placed beside that shape rather
     * than at a free slot somewhere else, because in Chen notation the
     * connector line is what says which shape an attribute describes. Landing it
     * across the canvas turns a readable diagram into a hairball and costs a
     * drag to fix every time.
     *
     * Reads the document straight from Yjs rather than from React state: this
     * closure is memoised on the room, so the state captured here would be
     * whatever the document looked like when the room was created.
     */
    addAttribute: (x, y, ownerId = null) => {
      const id = makeId('attr');
      const live = snapshotFromYdoc(room.ydoc);
      if (!canOwnAttribute(live, id, ownerId)) {
        setNotice('This shape cannot own an attribute.');
        return '';
      }
      const slot = findAttributeSlot(live, ownerId);
      const nextX = slot ? slot.x : x;
      const nextY = slot ? slot.y : y;
      // Numbered rather than all called "attribute", so a diagram with several
      // attributes does not look like a row of identical shapes.
      const index = live.attributes.filter((a) => a.ownerId === ownerId).length + 1;
      const name = ownerId ? String(index) : 'attribute';
      mutate(() => upsertAttribute(room.ydoc, { id, name, x: nextX, y: nextY, kind: 'simple', ownerId }), true);
      setSelection([id]);
      setJustCreated(id);
      return id;
    },

    addRelationship: (x, y) => {
      const id = makeId('rel');
      mutate(() => upsertRelationship(room.ydoc, { id, name: 'relationship', x, y, kind: 'strong' }), true);
      setSelection([id]);
      setJustCreated(id);
      return id;
    },

    addIsa: (x, y) => {
      const id = makeId('isa');
      mutate(() => upsertIsa(room.ydoc, { id, x, y, parentId: null, childIds: [] }), true);
      setSelection([id]);
      setJustCreated(id);
      return id;
    },

    connect: (fromId, toId) => {
      let id: string | null = null;
      mutate(() => { id = connectNodes(room.ydoc, fromId, toId, makeId); }, true);
      if (id && room.ydoc.getMap('relationships').has(id)) {
        setSelection([id]);
        setJustCreated(id);
        setTool('select');
      }
      return id;
    },

    connectColumns: (from, to) => {
      let id: string | null = null;
      mutate(() => { id = connectColumns(room.ydoc, from, to, makeId); }, true);
      if (id) {
        setSelection([id]);
        setJustCreated(id);
        setTool('select');
      } else setNotice('That connection could not be made. Choose two different, available attributes.');
      return id;
    },

    /**
     * Deletes everything selected, as a single undo step.
     *
     * One transaction for the whole set, so Undo brings the whole selection back
     * rather than needing one press per shape. Naming the count in the notice
     * matters because deleting five things at once is otherwise alarming.
     */
    remove: (ids) => {
      if (ids.length === 0) return;
      const live = snapshotFromYdoc(room.ydoc);
      const everything = [...live.entities, ...live.attributes, ...live.relationships, ...live.isas, ...live.legs];
      const removed = ids.map((id) => everything.find((node) => node.id === id)).filter(Boolean);
      if (removed.length === 0) return;
      mutate(() => {
        for (const id of ids) deleteNodeFromYdoc(room.ydoc, id);
      }, true);
      const label = (node: NonNullable<typeof removed[number]>) =>
        ('name' in node ? node.name || 'Shape' : 'Line');
      setNotice(removed.length === 1
        ? label(removed[0]!) + ' deleted.'
        : removed.length + ' shapes deleted.');
      setSelection((current) => current.filter((id) => !ids.includes(id)));
    },

    /**
     * Groups the given shapes, or dissolves the group they form.
     *
     * Creating and dissolving are both single transactions, so Undo reverses
     * either in one press. A shape belongs to one group at a time: grouping
     * something already grouped moves it rather than listing it in two frames,
     * which would make dragging one of them ambiguous.
     */
    group: (ids, name) => {
      if (ids.length < 2) return null;
      const live = snapshotFromYdoc(room.ydoc);
      const existing = live.groups.find((g) => ids.every((id) => g.memberIds.includes(id)));
      if (existing) {
        mutate(() => deleteGroupFromYdoc(room.ydoc, existing.id), true);
        setNotice('Group removed.');
        return null;
      }
      const id = makeId('grp');
      mutate(() => setGroupMembers(room.ydoc, id, name || 'Group', ids), true);
      setNotice('Grouped ' + ids.length + ' shapes.');
      return id;
    },

    ungroup: (id) => {
      const live = snapshotFromYdoc(room.ydoc);
      const group = live.groups.find((g) => g.id === id);
      if (!group) return;
      mutate(() => deleteGroupFromYdoc(room.ydoc, id), true);
      setNotice('Group removed.');
    },

    replaceDocument: (next: ErdDocument) => {      mutate(() => {
        const { ydoc } = room;
        // Groups are listed because importing now happens *in* the current room:
        // leaving them behind would strand groups whose members are gone.
        for (const key of ['entities', 'attributes', 'relationships', 'isas', 'legs', 'groups'] as const) {
          ydoc.getMap(key).clear();
        }
        seedDocument(ydoc, next);
        setMeta(ydoc, { name: next.name, view: next.view });
        /*
         * Adopt the file's notation. This is the only caller of
         * `replaceDocument`, and it is *my* import, not a collaborator's edit —
         * a collaborator changing the document never reaches this path, so
         * their notation choice is still untouched. Import used to land in a
         * fresh room, where the file's view won because no preference existed
         * there yet; importing in place must not quietly keep showing the file
         * in the wrong notation.
         */
        setLocalView(next.view);
      // `separate` because an import is one deliberate, whole-document act: without
      // it the 400ms capture window merges the import into whatever the person
      // did just before, and a single Undo takes both away.
      }, true);
    },

    applyPositions: (positions: Map<string, { x: number; y: number }>) => {
      mutate(() => {
        for (const [id, pos] of positions) {
          for (const key of ['entities', 'attributes', 'relationships', 'isas'] as const) {
            const map = room.ydoc.getMap(key).get(id) as Y.Map<unknown> | undefined;
            if (map) {
              map.set('x', pos.x);
              map.set('y', pos.y);
              break;
            }
          }
        }
      }, true);
    },

    /**
     * Moves tables in the Crow's-foot view.
     *
     * Written to `crowX`/`crowY` rather than `x`/`y`, so a table dragged here
     * never moves its entity in Chen, and a collaborator sees the move — the
     * two notations are arranged separately, not separately *privately*.
     */
    applyTablePositions: (positions: Map<string, { x: number; y: number }>) => {
      mutate(() => {
        for (const [id, pos] of positions) {
          setCrowPlacement(room.ydoc, id, pos.x, pos.y, true);
        }
      }, true);
    },

    /**
     * Places tables the person did not move, and is deliberately not undoable.
     *
     * This is the app finding somewhere sensible for a table it has just seen
     * for the first time, not an edit anybody made. Transaction origin matters
     * here: the UndoManager tracks the null origin, so going through `mutate`
     * put an automatic placement on the undo stack, and the first Undo after an
     * import then reverted the arrangement instead of the import.
     *
     * It is recorded as an arrangement and not as a move, so it never undoes
     * where somebody deliberately put a table.
     */
    placeTables: (positions: Map<string, { x: number; y: number }>) => {
      for (const [id, pos] of positions) {
        setCrowPlacement(room.ydoc, id, pos.x, pos.y, false, 'auto-place');
      }
    },

    /**
     * Renames you, for the people you are drawing with.
     *
     * Generated names like "Swift Otter" are fine until two people in a room
     * both get one and nobody can say which is which. The choice is stored per
     * browser rather than per room, because a person is the same person in
     * every room they open.
     */
    setIdentityName: (name: string) => {
      const trimmed = name.trim().slice(0, 32);
      if (trimmed.length === 0) return;
      setIdentity((current) => ({ ...current, name: trimmed }));
      rememberIdentity({ name: trimmed, color: identity.color });
    },
  }), [room, mutate, identity.color]);

  return {
    room: room.room,
    identity,
    doc: visibleDoc,
    view,
    notice,
    ...history,
    peers,
    connected,
    directPeers,
    transport,
    loaded,
    selection,
    pointer,
    viewport,
    tool,
    ydoc: room.ydoc,
    awareness: room.awareness,
    ...api,
    justCreated,
  };
}
