/**
 * Shapes that have left the document but are still on the paper, dissolving.
 *
 * The entrance blooms each shape in as it is written; this is its partner. A
 * removal that drops the shape in the frame the document loses it reads as the
 * page glitching — a lasso ring closes around a hole that was not there a
 * moment ago. Holding the last render of each removed shape a moment longer,
 * while it fades and settles, makes a removal an event on the paper instead
 * of an absence.
 *
 * The shapes present when the view opens are the baseline: loading a file or
 * switching notation re-mounts the whole drawing, and dissolving all of it at
 * once is motion with no event behind it. A baseline shape that is removed
 * later still exits like any other.
 */

import { useEffect, useRef, useState } from 'react';

/**
 * How long a removed shape stays on the paper.
 *
 * Shorter than any entrance, as the motion contract requires: a departure is
 * something the reader is recovering from, not something being announced.
 */
export const DEPART_MS = 280;

/**
 * Returns the shapes that vanished from `present` on the last change, kept
 * around so they can play their way off the paper.
 */
export function useDepartures<T>(present: T[], idOf: (item: T) => string, durationMs = DEPART_MS): T[] {
  const [departing, setDeparting] = useState<T[]>([]);
  const baseline = useRef(false);
  const seen = useRef<Map<string, T>>(new Map());

  if (!baseline.current && present.length > 0) {
    baseline.current = true;
    seen.current = new Map(present.map((item) => [idOf(item), item]));
  }

  useEffect(() => {
    if (!baseline.current) return;
    const next = new Map(present.map((item) => [idOf(item), item]));
    // Shapes that arrived since the last change are remembered too, so a
    // shape that appears and then disappears in a stream still exits.
    for (const [id, item] of next) seen.current.set(id, item);
    const gone: T[] = [];
    for (const [id, item] of seen.current) if (!next.has(id)) gone.push(item);
    for (const item of gone) seen.current.delete(idOf(item));
    if (gone.length === 0) return;
    const goneIds = new Set(gone.map(idOf));
    setDeparting((current) => [
      ...current.filter((item) => !goneIds.has(idOf(item))),
      ...gone.filter((item) => !current.some((pending) => idOf(pending) === idOf(item))),
    ]);
  }, [present, idOf]);

  // Whatever is still pending is swept on its own clock, not the document's:
  // an unrelated change arriving mid-fade used to cancel the only timer that
  // would ever take the ghost off the paper.
  useEffect(() => {
    if (departing.length === 0) return;
    const timer = setTimeout(() => setDeparting([]), durationMs);
    return () => clearTimeout(timer);
  }, [departing, durationMs]);

  return departing;
}
