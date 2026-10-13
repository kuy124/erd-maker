/**
 * Themes.
 *
 * The drawing surface is a sheet of paper on a desk, so a theme is a paper and
 * an ink rather than a restyle: it changes the tint of the sheet and the colours
 * on it, and nothing about the drawing itself. Every theme redefines the same
 * tokens, so any rule written against a token works in all of them.
 *
 * These are palettes other tools ship and people already have in their head —
 * Solarized, Dracula, Nord, GitHub's dark, Monokai — using the values those
 * projects publish, rather than invented names nobody can picture. Invented
 * themes were the first attempt and were rightly rejected: a theme you have
 * never seen is one more thing to evaluate every time you open the app.
 *
 * A choice is stored in this browser and wins over `prefers-color-scheme`;
 * picking "System" clears it so the setting goes back to following the machine.
 */

export const THEMES = [
  {
    id: 'system',
    name: 'System',
    note: 'Follows your device’s light or dark setting.',
  },
  {
    id: 'graph-light',
    name: 'Light',
    note: 'The default: white paper, teal accents.',
  },
  {
    id: 'graph-dark',
    name: 'Dark',
    note: 'The same, in charcoal.',
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    note: 'Ethan Schoonover’s warm, low-contrast light palette.',
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    note: 'The same palette, inverted.',
  },
  {
    id: 'dracula',
    name: 'Dracula',
    note: 'Purple accents on charcoal.',
  },
  {
    id: 'nord',
    name: 'Nord',
    note: 'Arctic, north-bluish. Muted on purpose.',
  },
  {
    id: 'github-dark',
    name: 'GitHub Dark',
    note: 'The colours of github.com in dark mode.',
  },
  {
    id: 'monokai',
    name: 'Monokai',
    note: 'The classic editor palette.',
  },
] as const;

export type ThemeId = typeof THEMES[number]['id'];

const KEY = 'erd:theme';

export function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

export function savedTheme(): ThemeId {
  try {
    const stored = localStorage.getItem(KEY);
    return isThemeId(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

/**
 * Applies a theme to the document element.
 *
 * Setting `data-theme` on the root is what the stylesheet keys off. `system`
 * removes it rather than naming a theme, so the media query keeps working.
 */
export function applyTheme(theme: ThemeId): void {
  try {
    if (theme === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // A blocked store costs the choice, not the session.
  }
  if (typeof document === 'undefined') return;
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

/** Applies the saved choice. Called once at startup, before the first paint. */
export function restoreTheme(): void {
  applyTheme(savedTheme());
}