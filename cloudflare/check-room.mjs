import assert from 'node:assert/strict';
import { DiagramRoom } from './worker.js';

/*
 * A room has to outlive its last connection.
 *
 * A short share link names only the room, so a joiner can arrive hours after
 * everyone closed their tabs. This drives the storage contract directly: no
 * WebSocket, no running worker, just the object and a stand-in for Durable
 * Object storage. Run it when the room storage code changes.
 */
const saved = new Map();
const storage = {
  get: async key => saved.get(key),
  put: async (key, value) => { saved.set(key, value); },
};
const waitUntil = () => {};

const first = new DiagramRoom({ storage, waitUntil });
await first.ready;
first.doc.getMap('check').set('kept', 'after everyone left');
first.save();
await new Promise(resolve => setTimeout(resolve, 0));
assert.ok(saved.get('doc'), 'Room was never written to storage');

const later = new DiagramRoom({ storage, waitUntil });
await later.ready;
assert.equal(later.doc.getMap('check').get('kept'), 'after everyone left',
  'A visitor arriving after everyone left got an empty room');

console.log('PASS: a room opens with nobody connected');
// Awareness keeps a timer alive; the worker runtime does not care, Node does.
process.exit(0);
