# ERD Maker

Draw entity-relationship diagrams in Chen notation or as crow's-foot tables, together, in a browser.

There is no server and no account. Two people open the same share link and edit the same diagram at
the same time.

## Running it

```bash
npm install
npm run dev       # http://localhost:5173
```

```bash
npm run verify    # unit tests, typecheck, production build, end-to-end tests
```

The end-to-end suite starts two servers of its own: `vite preview` for the built app, and y-webrtc's
signalling server so the WebRTC tests are deterministic and work offline.

## Notation

Chen notation is the primary view and covers the full notation:

| Shape | Meaning |
| --- | --- |
| Rectangle | entity |
| Ellipse | attribute |
| Diamond | relationship |
| Triangle | specialization (ISA) |
| Double rectangle | weak entity |
| Double diamond | identifying relationship |
| Double ellipse | multivalued attribute |
| Dashed ellipse | derived attribute |

Key attributes are underlined. Relationship lines carry a cardinality and a `(min,max)`
participation, both editable by clicking the line or its label.

The crow's-foot view is the same document drawn a different way, not a second model: every entity
becomes a table, key attributes become the primary key, and relationships become crow's-foot
connectors.

## Drawing

Select a shape, then press `A` to add an attribute. It lands beside its owner in a column, already
connected, with its name ready to type — press `A` again to add another to the same shape.

To draw a relationship line, hold `Shift` and click two shapes. A dashed line follows your pointer and
the shape under it is highlighted, so you can see what will connect before you click. `Escape` or a
click on empty paper cancels.

`Tidy` arranges everything, so a diagram built in any order still reads properly.

## Collaboration

- **Same browser, several tabs** sync over `BroadcastChannel`. No network at all.
- **Different devices** sync over WebRTC. A signalling server introduces two peers, then gets out of
  the way; it never sees diagram content, because the room id doubles as the encryption key.
- **A share link works with nobody online.** The document snapshot is compressed into the URL
  fragment, so the link reconstructs the diagram on its own. A refresh rejoins the same room.

If no signalling server is reachable, the app still works: same-browser tabs still sync, and share
links still open. Only cross-device live editing is lost, and the status line says so.

The default signalling server is `wss://signaling.fly.dev`. Override it with `?signaling=` in the
query string, `window.__ERD_SIGNALING__`, or `VITE_SIGNALING` at build time. Run
`node scripts/probe-signaling.mjs` to check whether a candidate actually introduces peers, which a
socket opening does not prove.

## Export

SVG, PNG, JSON, and SQL DDL. The SQL generator follows the textbook mapping: a strong entity becomes
a table, a weak entity borrows its parent's key, a many-to-many relationship becomes a junction
table, and a one-to-many relationship adds a foreign key to the many side.

## Keyboard

| Key | Action |
| --- | --- |
| `E` / `A` / `R` / `S` | add entity / attribute / relationship / specialization |
| `V` / `H` | select tool / pan tool |
| `Shift`-click two shapes | connect them |
| `Delete` | delete the selected shape |
| `Ctrl`+`Z`, `Ctrl`+`Shift`+`Z` | undo, redo |

## Design notes

The interface is built from the diagram's own primitives: hairline ink on drafting paper, no shadows,
no fills, and colour reserved for collaborator identity and active state. Radii vary by purpose
rather than being one value everywhere — zero for drawn shapes, 2px for controls, 3px for panels,
pill for avatars.

IBM Plex Sans and IBM Plex Mono carry it, because a schema tool is mostly names, cardinalities, and
identifiers, and identifiers should be monospaced.

Contrast is verified in both light and dark mode and held to WCAG AA by tests, not by eye. Dark mode
follows the operating system.
