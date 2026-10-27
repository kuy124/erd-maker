/**
 * Peer identity.
 *
 * Every collaborator gets a name and a colour. The colour is always paired
 * with the name in the UI, so colour is never the only thing distinguishing
 * one person from another — a colourblind-safe set matters less when the name
 * is right there, but a set that survives greyscale is still the polite
 * choice.
 */

export interface Identity {
  clientId: number;
  /** Browser identity; unlike a display name or Yjs client id, survives rooms and reloads. */
  userId: string;
  name: string;
  color: string;
  /** Index into PRESENCE_COLORS, so avatars can be ordered stably. */
  colorIndex: number;
}

export function initials(name: string): string {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?';
}

/**
 * Colours chosen to stay distinguishable in greyscale and at low saturation
 * against the cool paper background. Each is paired with its own text-safe
 * dark variant for labels drawn on white.
 */
export const PRESENCE_COLORS = [
  '#0F7B8A', // schematic teal (matches the app's signal colour)
  '#B4552F', // clay
  '#8A3E6B', // plum
  '#4F7A3A', // moss
  '#C88A00', // amber
  '#2F5DA8', // cobalt
  '#8A6A2F', // bronze
  '#6B3FA0', // violet
] as const;

const ADJECTIVES = [
  'Swift', 'Quiet', 'Bright', 'Amber', 'Clever', 'Steady', 'Copper', 'Ivory',
  'Silver', 'Cobalt', 'Gentle', 'Bold', 'Lucid', 'Rustic', 'Verdant', 'Slate',
];

const NOUNS = [
  'Otter', 'Falcon', 'Heron', 'Marten', 'Lynx', 'Bison', 'Tern', 'Ibis',
  'Finch', 'Osprey', 'Stoat', 'Wren', 'Crane', 'Gecko', 'Raven', 'Moth',
];

/** Deterministic name from a numeric seed, so a peer's name is stable. */
export function nameFromSeed(seed: number): string {
  const a = ADJECTIVES[Math.abs(Math.floor(seed)) % ADJECTIVES.length]!;
  const n = NOUNS[Math.abs(Math.floor(seed / 7)) % NOUNS.length]!;
  return `${a} ${n}`;
}

export function colorFromSeed(seed: number): { color: string; colorIndex: number } {
  const colorIndex = Math.abs(Math.floor(seed)) % PRESENCE_COLORS.length;
  return { color: PRESENCE_COLORS[colorIndex]!, colorIndex };
}

export function identityFor(clientId: number): Omit<Identity, 'userId'> {
  const { color, colorIndex } = colorFromSeed(clientId);
  return { clientId, name: nameFromSeed(clientId), color, colorIndex };
}

/** Relative luminance, per WCAG 2.x. */
function luminance(hex: string): number {
  const clean = hex.replace('#', '');
  const channels = [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16) / 255);
  const linear = channels.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The readable ink for text drawn on top of a presence colour.
 *
 * Presence colours are fixed and do not change with the theme, so the text on
 * them cannot come from a theme token: `--ink-inverse` is near-white in light
 * mode and near-black in dark, and each of those fails on some entry in the
 * palette. The colour is picked per fill instead, which is also what lets the
 * same avatar be legible in both themes.
 */
const LIGHT_INK = '#fbfcfb';
const DARK_INK = '#14171a';

export function presenceInk(fill: string): string {
  return contrastRatio(LIGHT_INK, fill) >= contrastRatio(DARK_INK, fill) ? LIGHT_INK : DARK_INK;
}

let fallbackUserId: string | undefined;

function browserUserId(): string {
  // ponytail: browser-local identity; authenticated accounts are needed to survive cleared storage or another browser.
  try {
    const stored = localStorage.getItem('erd:user-id');
    if (stored && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stored)) return stored;
    const id = crypto.randomUUID();
    localStorage.setItem('erd:user-id', id);
    return id;
  } catch {
    return fallbackUserId ??= crypto.randomUUID();
  }
}

/** A browser identity, overridable by the user and shared across diagrams. */
export function createLocalIdentity(clientId: number): Identity {
  const base: Identity = { ...identityFor(clientId), userId: browserUserId() };
  try {
    const stored = localStorage.getItem('erd:identity');
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<Identity>;
      if (typeof parsed.name === 'string' && parsed.name.trim().length > 0) {
        base.name = parsed.name.trim().slice(0, 32);
      }
      if (typeof parsed.color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(parsed.color)) {
        base.color = parsed.color;
      }
    }
  } catch {
    // localStorage can throw in private mode; a generated name is fine.
  }
  rememberIdentity(base);
  return base;
}

export function rememberIdentity(identity: Pick<Identity, 'name' | 'color'>): void {
  try {
    localStorage.setItem('erd:identity', JSON.stringify({ name: identity.name, color: identity.color }));
  } catch {
    // Non-fatal: the identity just will not persist across reloads.
  }
}
