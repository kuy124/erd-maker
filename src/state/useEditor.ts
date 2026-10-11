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
import { connectedPeerCount, readPeers, type PeerState, type RoomHandle } from '../collab/provider';
import { createLocalIdentity, type Identity } from '../collab/identity';
import {
  connectColumns,
  connectNodes,
  deleteGroupFromYdoc,
  deleteNodeFromYdoc,
  seedDocument,
  setGroupMembers,
  setMeta,
  snapshotFromYdoc,
  upsertAttribute,
  upsertEntity,
  upsertIsa,
  upsertRelationship,
} from '../collab/ydoc';
import { writeParticipants, type RelationshipParticipant } from '../collab/participants';
import { validParticipation } from '../model/issues';
import { findAttributeSlot } from '../model/placement';
import { emptyDocument, type ErdDocument } from '../model/types';
import type { ColumnEndpoint } from '../model/crowfoot';

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
  updateEntity: (id: string, patch: Partial<{ name: string; x: number; y: number; kind: 'strong' | 'weak' }>) => void;
  updateAttribute: (id: string, patch: Partial<{ name: string; x: number; y: number; kind: string; ownerId: string | null }>) => void;
  updateRelationship: (id: string, patch: Partial<{ name: string; x: number; y: number; kind: 'strong' | 'weak' }>) => void;
  updateLeg: (id: string, patch: Partial<{ cardinality: '1' | 'N' | 'M'; min: number; max: number | 'N' }>) => void;
  setParticipants: (relationshipId: string, participants: RelationshipParticipant[]) => void;
  updateIsaParent: (id: string, parentId: string | null) => void;
  updateIsaChildren: (id: string, childId: string, included: boolean) => void;
  addEntity: (x: number, y: number) => string;
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
  const [identity] = useState<Identity>(() => createLocalIdentity(room.ydoc.clientID));
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

  // Track whether the WebRTC transport actually has peers. This is a second
  // signal on top of awareness: awareness can be populated by BroadcastChannel
  // alone, so the provider's own peer events are what tell us a cross-device
  // connection exists.
  useEffect(() => {
    const provider = room.provider;
    const update = () => setDirectPeers(connectedPeerCount(provider));
    provider.on('peers', update);
    provider.on('status', update);
    update();
    return () => {
      provider.off('peers', update);
      provider.off('status', update);
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

  const api = useMemo<Omit<EditorState, 'doc' | 'view' | 'canUndo' | 'canRedo' | 'notice' | 'peers' | 'connected' | 'directPeers' | 'loaded' | 'room' | 'identity' | 'selection' | 'pointer' | 'justCreated' | 'viewport' | 'tool' | 'ydoc' | 'awareness'>>(() => ({
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
        const map = room.ydoc.getMap('attributes').get(id) as Y.Map<unknown> | undefined;
        if (!map) return;
        for (const [key, value] of Object.entries(patch)) map.set(key, value as never);
      }),

    updateRelationship: (id, patch) =>
      mutate(() => {
        const map = room.ydoc.getMap('relationships').get(id) as Y.Map<unknown> | undefined;
        if (!map) return;
        for (const [key, value] of Object.entries(patch)) map.set(key, value as never);
      }),

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

    addEntity: (x, y) => {
      const id = makeId('ent');
      mutate(() => upsertEntity(room.ydoc, { id, name: 'New entity', x, y, kind: 'strong' }), true);
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
        for (const key of ['entities', 'attributes', 'relationships', 'isas', 'legs'] as const) {
          ydoc.getMap(key).clear();
        }
        seedDocument(ydoc, next);
        setMeta(ydoc, { name: next.name, view: next.view });
      });
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
  }), [room, mutate]);

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
