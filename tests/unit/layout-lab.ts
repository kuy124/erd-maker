/** Lab helpers for Auto-arrange tuning. Temporary; not a regression test. */
import type { ErdDocument, EntityKind } from '../../src/model/types';

export const INK = '#16181a', FILL = '#fbfcfb', SUB = 'rgba(22,24,26,.55)';
export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface Box { id: string; label: string; x: number; y: number; w: number; h: number; dashed?: boolean; lines?: string[] }
export interface Edge { fromId: string; toId: string; label?: string; pts: { x: number; y: number }[] }

export interface Measure { overlaps: number; edgeThroughBox: number; crossings: number; coincident: number;
  w: number; h: number; areaFactor: number; nearest: number[]; stubs: number }

export function lineHitsBox(a: { x: number; y: number }, b: { x: number; y: number }, r: { x: number; y: number; w: number; h: number }) {
  const minx = r.x, maxx = r.x + r.w, miny = r.y, maxy = r.y + r.h;
  if (Math.min(a.x, b.x) > maxx || Math.max(a.x, b.x) < minx || Math.min(a.y, b.y) > maxy || Math.max(a.y, b.y) < miny) return false;
  if (a.x > minx && a.x < maxx && a.y > miny && a.y < maxy) return true;
  const E = [{ x1: { x: minx, y: miny }, x2: { x: maxx, y: miny } }, { x1: { x: maxx, y: miny }, x2: { x: maxx, y: maxy } },
    { x1: { x: maxx, y: maxy }, x2: { x: minx, y: maxy } }, { x1: { x: minx, y: maxy }, x2: { x: minx, y: miny } }];
  return E.some(e => segsCross(a, b, e.x1, e.x2));
}

export function measure(boxes: Box[], edges: Edge[]): Measure {
  const byId = new Map(boxes.map(b => [b.id, b]));
  let overlaps = 0;
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) if (boxOverlap(boxes[i], boxes[j], 0)) overlaps++;
  let edgeThroughBox = 0, stubs = 0;
  for (const e of edges) {
    const own = new Set([e.fromId, e.toId]);
    let hit = false;
    for (let k = 1; k < e.pts.length - 1; k++)
      for (const b of boxes) {
        if (own.has(b.id)) continue;
        const p0 = e.pts[k - 1], p1 = e.pts[k];
        if (lineHitsBox(p0, p1, b)) { hit = true; }
        // A vertex strictly inside a foreign box: not a touch, an invasion.
        if (p1.x > b.x + 2 && p1.x < b.x + b.w - 2 && p1.y > b.y + 2 && p1.y < b.y + b.h - 2 && !hit) stubs++;
      }
    if (hit) edgeThroughBox++;
  }
  let crossings = 0, coincident = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const share = edges[i].fromId === edges[j].fromId || edges[i].fromId === edges[j].toId ||
        edges[i].toId === edges[j].fromId || edges[i].toId === edges[j].toId;
      const as = edges[i].pts, bs = edges[j].pts;
      let cross = false, over = false;
      for (let m = 0; m + 1 < as.length; m++) {
        for (let n = 0; n + 1 < bs.length; n++) {
          const a1 = as[m], a2 = as[m + 1], b1 = bs[n], b2 = bs[n + 1];
          if (segsCross(a1, a2, b1, b2)) cross = true;
          // Overlapping collinear axis-aligned runs = two lines printed on each other.
          if ((a1.x === a2.x && b1.x === b2.x && a1.x === b1.x &&
              Math.min(Math.max(a1.y, a2.y), Math.max(b1.y, b2.y)) - Math.max(Math.min(a1.y, a2.y), Math.min(b1.y, b2.y)) > 12) ||
              (a1.y === a2.y && b1.y === b2.y && a1.y === b1.y &&
              Math.min(Math.max(a1.x, a2.x), Math.max(b1.x, b2.x)) - Math.max(Math.min(a1.x, a2.x), Math.min(b1.x, b2.x)) > 12)) over = true;
        }
      }
      if (cross) { if (share) stubs++; else crossings++; }
      if (over) { if (share) stubs++; else coincident++; }
    }
  }
  const xs = boxes.map(b => b.x), ys = boxes.map(b => b.y);
  const x2 = boxes.map(b => b.x + b.w), y2 = boxes.map(b => b.y + b.h);
  const minX = Math.min(...xs), minY = Math.min(...ys), maxX = Math.max(...x2), maxY = Math.max(...y2);
  const w = maxX - minX, h = maxY - minY;
  const area = boxes.reduce((s, b) => s + b.w * b.h, 0);
  const nearest = boxes.map(b =>
    Math.min(...boxes.filter(o => o !== b).map(o => edgeGap(b, o))));
  const sorted = [...nearest].sort((p, q) => p - q);
  return { overlaps, edgeThroughBox, crossings, coincident, w, h, areaFactor: w * h / area,
    nearest: [sorted[0] ?? 0, sorted[Math.floor(sorted.length * 0.25)] ?? 0], stubs };
}

export function segsCross(p1: { x: number; y: number }, p2: { x: number; y: number }, p3: { x: number; y: number }, p4: { x: number; y: number }) {
  const d = (a: any, b: any, c: any) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

export function boxOverlap(a: Box, b: Box, pad = 1) {
  return a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
}

/** Edge-to-edge clear distance: 0 when overlapping on the shared projection band. */
export function edgeGap(a: Box, b: Box) {
  const vBand = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  const hBand = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), 0);
  const dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h), 0);
  if (vBand > 0) return dx;
  if (hBand > 0) return dy;
  return Math.hypot(dx, dy);
}

export function renderSvg(boxes: Box[], edges: Edge[]) {
  const xs = [...boxes.map(b => b.x), ...edges.flatMap(e => e.pts.map(p => p.x))];
  const ys = [...boxes.map(b => b.y), ...edges.flatMap(e => e.pts.map(p => p.y))];
  const minX = Math.min(...xs) - 30, minY = Math.min(...ys) - 30;
  const w = Math.max(...boxes.map(b => b.x + b.w), ...edges.flatMap(e => e.pts.map(p => p.x))) - minX + 30;
  const h = Math.max(...boxes.map(b => b.y + b.h), ...edges.flatMap(e => e.pts.map(p => p.y))) - minY + 30;
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" ` +
    `viewBox="${minX} ${minY} ${w} ${h}" font-family="ui-sans-serif, system-ui" font-size="12">` +
    `<rect x="${minX}" y="${minY}" width="${w}" height="${h}" fill="${FILL}"/>`;
  const body: string[] = [];
  for (const e of edges) {
    body.push(`<polyline points="${e.pts.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="${INK}" stroke-width="1"/>`);
    if (e.label && e.pts.length > 2) {
      const m = e.pts[Math.floor(e.pts.length / 2)];
      body.push(`<text x="${m.x + 3}" y="${m.y - 3}" font-size="9" fill="${SUB}">${esc(e.label)}</text>`);
    }
  }
  for (const b of boxes) {
    body.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="3" fill="white" stroke="${INK}" stroke-width="1.5"${b.dashed ? ' stroke-dasharray="5 4"' : ''}/>`);
    if (!b.lines) {
      body.push(`<text x="${b.x + b.w / 2}" y="${b.y + b.h / 2}" text-anchor="middle" dominant-baseline="middle" fill="${INK}">${esc(b.label)}</text>`);
    } else {
      body.push(`<text x="${b.x + 8}" y="${b.y + 13}" dominant-baseline="middle" font-weight="600" fill="${INK}">${esc(b.label)}</text>`);
      let y = b.y + 24;
      for (const line of b.lines) {
        body.push(`<line x1="${b.x + 6}" x2="${b.x + b.w - 6}" y1="${y}" y2="${y}" stroke="${SUB}" stroke-width="0.6"/>`);
        body.push(`<text x="${b.x + 8}" y="${y + 11}" dominant-baseline="middle" font-size="10" fill="${INK}">${esc(line)}</text>`);
        y += 22;
      }
    }
  }
  return head + body.join('') + '</svg>';
}

