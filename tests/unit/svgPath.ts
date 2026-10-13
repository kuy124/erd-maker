/** Interpret SVG commands as a browser does, including repeated H/V arguments. */
export function orthogonalPoints(path: string): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  let x = 0, y = 0;
  for (const match of path.matchAll(/([MHVL])([^MHVL]*)/g)) {
    const values = (match[2]!.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    for (let i = 0; i < values.length;) {
      if (match[1] === 'H') x = values[i++]!;
      else if (match[1] === 'V') y = values[i++]!;
      else { x = values[i++]!; y = values[i++]!; }
      points.push({ x, y });
    }
  }
  return points;
}
