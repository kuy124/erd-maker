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
import { createRoom, connectedPeerCount, readPeers, type PeerState, type RoomHandle } from '../collab/provider';
import { createLocalIdentity, type Identity } from '../collab/identity';
import {
  deleteNodeFromYdoc,
  seedDocument,
  setMeta,
  snapshotFromYdoc,
  upsertAttribute,
  upsertEntity,
  upsertIsa,
  upsertLeg,
  upsertRelationship,
} from '../collab/ydoc';
import { newRoomId, parseShareHash } from '../model/snapshot';
import { emptyDocument, type ErdDocument } from '../model/types';

export type Tool = 'select' | 'pan';

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
  peers: PeerState[];
  connected: boolean;
  /** Peers reachable over a direct WebRTC connection (not just same-browser). */
  directPeers: number;
  loaded: boolean;
  selection: string | null;
  viewport: Viewport;
  tool: Tool;
  setTool: (tool: Tool) => void;
  setSelection: (id: string | null) => void;
  setViewport: (updater: (v: Viewport) => Viewport) => void;
  setDocName: (name: string) => void;
  setView: (view: 'chen' | 'crowfoot') => void;
  updateEntity: (id: string, patch: Partial<{ name: string; x: number; y: number; kind: 'strong' | 'weak' }>) => void;
  updateAttribute: (id: string, patch: Partial<{ name: string; x: number; y: number; kind: string; ownerId: string | null }>) => void;
  updateRelationship: (id: string, patch: Partial<{ name: string; x: number; y: number; kind: 'strong' | 'weak' }>) => void;
  updateLeg: (id: string, patch: Partial<{ cardinality: '1' | 'N' | 'M'; min: number; max: number | 'N' }>) => void;
  updateIsaParent: (id: string, parentId: string | null) => void;
  updateIsaChildren: (id: string, childId: string, included: boolean) => void;
  addEntity: (x: number, y: number) => string;
  addAttribute: (x: number, y: number, ownerId?: string | null) => string;
  addRelationship: (x: number, y: number) => string;
  addIsa: (x: number, y: number) => string;
  connect: (fromId: string, toId: string) => string | null;
  remove: (id: string) => void;
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

export function useEditor(): EditorState {
  // Read the share hash once, at mount, before the room is created.
  const initial = useMemo(() => {
    if (typeof window === 'undefined') return { room: newRoomId(), doc: emptyDocument() };
    const parsed = parseShareHash(window.location.hash);
    return {
      room: parsed.room ?? newRoomId(),
      doc: parsed.doc ?? null,
    };
  }, []);

  const roomRef = useRef<RoomHandle | null>(null);
  if (roomRef.current === null) {
    roomRef.current = createRoom(initial.room);
  }
  const room = roomRef.current;

  const [doc, setDoc] = useState<ErdDocument>(() => initial.doc ?? emptyDocument());
  const [loaded, setLoaded] = useState(false);
  const [peers, setPeers] = useState<PeerState[]>([]);
  const [connected, setConnected] = useState(false);
  const [directPeers, setDirectPeers] = useState(0);
  const [selection, setSelection] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [identity] = useState<Identity>(() => createLocalIdentity(room.ydoc.clientID));

  // Seed the shared document from the share link, but only if it is empty —
  // otherwise a late joiner would overwrite a room that already has work in it.
  useEffect(() => {
    let cancelled = false;
    void room.whenLoaded.then(() => {
      if (cancelled) return;
      if (initial.doc) seedDocument(room.ydoc, initial.doc);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [room, initial.doc]);

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

  useEffect(() => {
    room.awareness.setLocalStateField('selectedId', selection);
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

  // Reflect the room in the URL so a refresh rejoins the same session.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    url.hash = `room=${room.room}`;
    window.history.replaceState(null, '', url.toString());
  }, [room.room]);

  useEffect(() => () => room.destroy(), [room]);

  const mutate = useCallback(
    (fn: () => void) => {
      room.ydoc.transact(fn);
    },
    [room],
  );

  const api = useMemo<Omit<EditorState, 'doc' | 'peers' | 'connected' | 'directPeers' | 'loaded' | 'room' | 'identity' | 'selection' | 'viewport' | 'tool' | 'ydoc' | 'awareness'>>(() => ({
    setTool,
    setSelection,
    setViewport,
    setDocName: (name: string) => setMeta(room.ydoc, { name }),
    setView: (view: 'chen' | 'crowfoot') => setMeta(room.ydoc, { view }),

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
        if (patch.cardinality !== undefined) map.set('cardinality', patch.cardinality);
        if (patch.min !== undefined) map.set('min', patch.min);
        if (patch.max !== undefined) map.set('max', patch.max);
      }),

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
      mutate(() => upsertEntity(room.ydoc, { id, name: 'New entity', x, y, kind: 'strong' }));
      setSelection(id);
      return id;
    },

    addAttribute: (x, y, ownerId = null) => {
      const id = makeId('attr');
      mutate(() => upsertAttribute(room.ydoc, { id, name: 'attribute', x, y, kind: 'simple', ownerId }));
      setSelection(id);
      return id;
    },

    addRelationship: (x, y) => {
      const id = makeId('rel');
      mutate(() => upsertRelationship(room.ydoc, { id, name: 'relationship', x, y, kind: 'strong' }));
      setSelection(id);
      return id;
    },

    addIsa: (x, y) => {
      const id = makeId('isa');
      mutate(() => upsertIsa(room.ydoc, { id, x, y, parentId: null, childIds: [] }));
      setSelection(id);
      return id;
    },

    connect: (fromId, toId) => {
      if (fromId === toId) return null;
      const id = makeId('leg');
      mutate(() =>
        upsertLeg(room.ydoc, {
          id,
          fromId,
          toId,
          cardinality: '1',
          participation: { min: 0, max: 1 },
        }),
      );
      return id;
    },

    remove: (id) => {
      mutate(() => deleteNodeFromYdoc(room.ydoc, id));
      setSelection((current) => (current === id ? null : current));
    },

    replaceDocument: (next: ErdDocument) => {
      mutate(() => {
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
      });
    },
  }), [room, mutate]);

  return {
    room: room.room,
    identity,
    doc,
    peers,
    connected,
    directPeers,
    loaded,
    selection,
    viewport,
    tool,
    ydoc: room.ydoc,
    awareness: room.awareness,
    ...api,
  };
}
