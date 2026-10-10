/**
 * Export.
 *
 * Four formats, each for a different job:
 *
 *   SVG   vector, for reports and slides — scales without blur
 *   PNG   raster, for pasting into chat or a submission portal
 *   JSON  the document itself, for save/load and version control
 *   SQL   the schema the diagram describes (see model/sql.ts)
 *
 * The SVG export does not screenshot the live canvas. Instead it serialises
 * the rendered `<svg>` element after inlining the computed styles that the
 * export needs, because a raw `outerHTML` would reference CSS variables that
 * do not exist in the exported file and would render as black boxes.
 */

import type { ErdDocument } from '../model/types';

/** CSS custom properties the exported SVG needs resolved to literal values. */
const EXPORT_VARS = [
  '--paper',
  '--paper-raised',
  '--ink',
  '--ink-secondary',
  '--ink-tertiary',
  '--signal',
  '--rule',
  '--font-sans',
  '--font-mono',
] as const;

function resolveVars(element: Element): Record<string, string> {
  const computed = getComputedStyle(element);
  const vars: Record<string, string> = {};
  for (const name of EXPORT_VARS) {
    const value = computed.getPropertyValue(name).trim();
    if (value) vars[name] = value;
  }
  return vars;
}

/**
 * Copies the computed presentation of every element onto the matching clone
 * element.
 *
 * The pairing is by document position, computed *before* any element is
 * removed from the clone. Removing first shifts every subsequent index by one,
 * which silently applies each shape's styles to the wrong shape — the export
 * looks plausible but renders as solid black blobs. Getting this ordering wrong
 * is what made an earlier version of this file produce unreadable output.
 */
function inlineStyles(source: SVGSVGElement, clone: SVGSVGElement): void {
  const sourceNodes = [source, ...Array.from(source.querySelectorAll('*'))];
  const cloneNodes = [clone, ...Array.from(clone.querySelectorAll('*'))];

  const props = [
    'fill',
    'stroke',
    'stroke-width',
    'stroke-dasharray',
    'stroke-linejoin',
    'font-family',
    'font-size',
    'font-weight',
    'text-anchor',
    'dominant-baseline',
    'paint-order',
    'opacity',
  ];

  for (let i = 0; i < sourceNodes.length; i += 1) {
    const from = sourceNodes[i];
    const to = cloneNodes[i] as SVGElement | undefined;
    if (!from || !to) continue;
    // Skip if the pairings have drifted apart; a wrong style is worse than none.
    if (from.tagName !== to.tagName) continue;
    const computed = getComputedStyle(from);
    for (const prop of props) {
      const value = computed.getPropertyValue(prop);
      if (value && value !== 'none' && value !== 'normal') {
        to.style.setProperty(prop, value);
      } else if (prop === 'fill' || prop === 'stroke') {
        // `none` is meaningful for outlines; keep it explicit.
        if (value === 'none') to.style.setProperty(prop, 'none');
      }
    }
  }
}

export interface SvgExportOptions {
  /** Background colour. `null` leaves the SVG transparent. */
  background?: string | null;
  padding?: number;
  /** Title element, used for the accessible name of the exported file. */
  title?: string;
}

/**
 * Serialises an on-screen SVG into a standalone string. The clone is given an
 * explicit viewBox so it renders correctly on its own, whatever the on-screen
 * pan and zoom happened to be.
 */
export function serializeSvg(
  svg: SVGSVGElement,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  options: SvgExportOptions = {},
): string {
  const padding = options.padding ?? 24;
  const width = Math.max(1, bounds.maxX - bounds.minX + padding * 2);
  const height = Math.max(1, bounds.maxY - bounds.minY + padding * 2);

  const clone = svg.cloneNode(true) as SVGSVGElement;

  // Styles are inlined FIRST, while the clone still has exactly the same nodes
  // in exactly the same order as the live SVG. `inlineStyles` pairs the two by
  // document position, so removing anything beforehand would shift every
  // subsequent pair by one and paint the wrong fill on the wrong shape.
  inlineStyles(svg, clone);

  // Then strip editing-only chrome: selection rings, peer cursors, hit targets.
  // Table row rules are NOT removed: they are part of the drawing.
  for (const selector of [
    '.selection-ring',
    '.peer-cursor',
    '.peer-ring',
    '.hit-target',
    '.leg-hit',
    '.connect-preview',
    '.crow-link__hit',
  ]) {
    clone.querySelectorAll(selector).forEach((n) => n.remove());
  }

  // Neutralise the on-screen pan and zoom.
  //
  // The viewBox below is set from the diagram's own bounds, which are world
  // coordinates. The live SVG wraps its content in `translate(x y) scale(z)`,
  // so leaving that in place maps the drawing somewhere else entirely and the
  // file shows an empty corner — or nothing — the moment the user has panned or
  // zoomed before exporting. Resetting the group puts the world coordinates
  // back in agreement with the viewBox.
  clone.querySelectorAll('[data-viewport]').forEach((node) => {
    node.removeAttribute('transform');
  });

  const vars = resolveVars(svg);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  clone.setAttribute('viewBox', `${bounds.minX - padding} ${bounds.minY - padding} ${width} ${height}`);
  clone.setAttribute('width', String(Math.round(width)));
  clone.setAttribute('height', String(Math.round(height)));
  clone.removeAttribute('style');
  clone.setAttribute('style', `--font-sans:${vars['--font-sans'] ?? 'sans-serif'};--font-mono:${vars['--font-mono'] ?? 'monospace'}`);

  const title = options.title ?? 'Entity relationship diagram';
  const titleEl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
  titleEl.textContent = title;
  clone.insertBefore(titleEl, clone.firstChild);

  const background = options.background === undefined ? vars['--paper'] ?? '#ffffff' : options.background;
  if (background) {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(bounds.minX - padding));
    rect.setAttribute('y', String(bounds.minY - padding));
    rect.setAttribute('width', String(width));
    rect.setAttribute('height', String(height));
    rect.setAttribute('fill', background);
    clone.insertBefore(rect, clone.firstChild);
  }

  return new XMLSerializer().serializeToString(clone);
}

/**
 * Rasterises an SVG string to a PNG blob. Done by loading the SVG into an
 * `<img>` rather than drawing the DOM, so the output is exactly the exported
 * vector, at whatever scale is requested.
 */
export async function svgToPng(svg: string, scale = 2): Promise<Blob> {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  try {
    const image = await loadImage(url);
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not create a canvas context for PNG export.');
    ctx.drawImage(image, 0, 0, width, height);

    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!png) throw new Error('The browser refused to encode the PNG.');
    return png;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The SVG could not be rasterised.'));
    image.src = url;
  });
}

/** Serialises the document to formatted JSON, stable across saves. */
export function serializeJson(doc: ErdDocument): string {
  return JSON.stringify(doc, null, 2) + '\n';
}

export interface ParsedImport {
  doc: ErdDocument | null;
  error: string | null;
}

/** Parses an imported JSON file, reporting a useful message on failure. */
export function parseJsonImport(text: string): ParsedImport {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return { doc: null, error: 'That file does not contain a diagram.' };
    }
    return { doc: parsed as ErdDocument, error: null };
  } catch {
    return { doc: null, error: 'That file is not valid JSON.' };
  }
}

/** Triggers a download of a blob under a given filename. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next frame so the download has started.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(text: string, filename: string, mime = 'text/plain'): void {
  downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), filename);
}

/** A filesystem-safe filename stem from the document name. */
export function fileStem(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'erd';
}

/** Copies text to the clipboard, falling back for older or insecure contexts. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}
