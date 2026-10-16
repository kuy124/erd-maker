# Design

The visual thesis, in one place. The stylesheet implements it; this file is why.
When a rule and this document disagree, one of them is a bug — a changed rule
without a changed reason is how a design system drifts into a pile of one-offs.

## The thesis

**The interface is built from the diagram's own primitives.**

The chrome is hairline ink on drafting paper. There are no fills, no shadows, and
no gradients in the app surface, so the only saturated colour on screen is either
a collaborator's identity or an active state. The canvas is a sheet of paper, not
a dashboard: it holds the drawing and gets out of its way.

This is a diagram tool. A drafting surface — the grid — is the domain's real
metaphor, not decoration painted on to look technical.

## Palette

Three cores and one accent, at the limit. Every value is a token; nothing is
written inline.

| Role | Token | Light | Dark | Used for |
| --- | --- | --- | --- | --- |
| Paper | `--paper` | `#f2f4f3` | `#14171a` | The sheet the drawing sits on |
| Raised paper | `--paper-raised` | `#fbfcfb` | `#1b1f22` | Panels and controls above the sheet |
| Fine grid | `--grid-fine` | `#e4e8e6` | `#1f2428` | 20px drafting lines |
| Major grid | `--grid-major` | `#d8dedb` | `#262c30` | 100px drafting lines |
| Rule | `--rule` | `#d3d8d6` | `#2b3136` | Separators, where 3:1 is not required |
| Rule strong | `--rule-strong` | `#7f8a87` | `#68737a` | Control borders, which must clear 3:1 |
| Ink | `--ink` | `#16181a` | `#e8eceb` | Body and headings |
| Ink secondary | `--ink-secondary` | `#5b6167` | `#a4adb2` | Supporting copy |
| Ink tertiary | `--ink-tertiary` | `#666e73` | `#98a1a6` | Helper text |
| Signal | `--signal` | `#0f7b8a` | `#3fa8b8` | Selection and live presence **only** |
| Danger | `--danger` | `#a32d1f` | `#e0776a` | Destructive actions and errors |
| Warn | `--warn` | `#8a5a00` | `#d9a441` | Recoverable warnings |

**The signal rule is load-bearing.** Teal is reserved for selection and live
presence, and nothing else uses it. The moment the accent spreads to buttons,
icons, badges, and borders, it stops being an accent and the selection state
loses its only visual channel. When adding a control, the question is not "would
teal look good here" but "is this selection or presence".

**Rule vs rule-strong is not a shade choice.** `--rule` is for separators.
`--rule-strong` is for interactive control borders, which have to clear 3:1
against the surface behind them so an input is identifiable without relying on
its placeholder.

## Geometry

Radii vary by purpose, never one value everywhere. This is what makes the
drawing read as drawn rather than as UI chrome sitting on top of a picture.

| Token | Value | Purpose |
| --- | --- | --- |
| `--r-drawn` | `0` | Canvas furniture that should read as drawn |
| `--r-control` | `2px` | Controls that should read as pressed metal |
| `--r-panel` | `3px` | Panels and cards |
| `--r-pill` | `999px` | Presence avatars, and nothing else |

Spacing is a single 4px-based scale (`--s1` … `--s7`) so rhythm comes from
choosing a level, not from inventing a number.

## Elevation

**There are no shadows, with exactly one exception.** Nothing on the paper is
lifted off it; layering is expressed with rules and paper tint instead.

`--shadow-menu` is the exception because a context menu is not on the paper at
all — it floats above the work, and without an edge it reads as another panel
rather than as something that will dismiss. Elevation earns a shadow only where
a surface genuinely hovers over the page. Not modals, not cards, not navbar.

## Type and colour

IBM Plex Sans and IBM Plex Mono, chosen for a drafting-tool character rather than
picked from a default roster. Mono is reserved for things that *are* data: SQL,
identifiers, key names.

Themes are palettes other tools already ship (Solarized, Dracula, Nord, GitHub
Dark, Monokai), using the values those projects publish, so a theme is
recognisable before it is read. A theme is a sheet of paper and the ink on it —
only colour tokens change, never geometry or motion. Where a published palette's
secondary ink would fall below 4.5:1, a step from the same ramp is used instead.

## Motion

Short, functional, and never ambient. Entrances and exits only, driven by user
action; exits are faster than entrances.

There are **no keyframe animations and no infinite loops in this app**, and that
is a rule rather than an accident. Motion draws attention to a change; a pulse
that never stops competes with the content for a fact that does not exist.

## Accessibility floor

- Body text clears **4.5:1**; control borders clear **3:1**. This is enforced by
  a test that reads the stylesheet, not by review.
- Every interactive element is reachable and operable by keyboard alone.
- Reduced motion is respected.
- The canvas grid is a known contrast hazard: copy must never sit directly on a
  grid line. The empty state carries its own solid fill for this reason.
- SVG exports strip editing chrome (selection rings, hit targets, presence)
  rather than exporting a screenshot of the working view.

## Enforced by test

Two unit tests hold this document to the code, so it cannot rot into prose:

- `tests/unit/design-tokens.test.ts` — every `var(--x)` a rule reads is set
  somewhere (stylesheet or script); the document tokens exist; the shadow
  vocabulary is capped at one.
- `tests/unit/theme.test.ts` — every theme defines every token it needs and
  holds the contrast bar.

## Not in this design, deliberately

There is no glassmorphism, no glow, no bento grid, no stat-card row, no
decorative gradient, no emoji, no badge-with-a-dot, and no animated hero. These
are not oversights to be corrected later; they are excluded because they would
each cost legibility or attention without adding information. A future change
that wants one of them needs a written reason here first, like `--shadow-menu`
has.
