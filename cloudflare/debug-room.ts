import * as Y from 'yjs';
import { DiagramRoom } from '../cloudflare/worker.js';

const calls = [];
const ctx = { storage: { get: async () => undefined, put: async (k, v) => calls.push(['put', k, v.length]) }, waitUntil: (p) => p.catch(() => {}) };
const room = new DiagramRoom(ctx);
await room.ready;
console.log('ready');
room.doc.getMap('keep').set('survives', 'a restart');
await new Promise((r) => setTimeout(r, 700));
console.log('calls after debounce:', calls);
room.save();
await new Promise((r) => setTimeout(r, 100));
console.log('calls after save:', calls);
process.exit(0);
