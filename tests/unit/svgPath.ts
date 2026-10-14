import { simplifyRoute } from '../../src/model/connectorRouting';

/** Interpret straight runs and recover their original orthogonal corners from rounded Q turns. */
export function orthogonalPoints(path: string): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  let x = 0, y = 0;
  for (const match of path.matchAll(/([MHVLQ])([^MHVLQ]*)/g)) {
    const values = (match[2]!.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    for (let i = 0; i < values.length;) {
      if (match[1] === 'Q') {
        points.pop(); points.push({ x: values[i++]!, y: values[i++]! });
        x = values[i++]!; y = values[i++]!;
      } else if (match[1] === 'H') x = values[i++]!;
      else if (match[1] === 'V') y = values[i++]!;
      else { x = values[i++]!; y = values[i++]!; }
      points.push({ x, y });
    }
  }
  return path.includes('Q') ? simplifyRoute(points) : points;
}
