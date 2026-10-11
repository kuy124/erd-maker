# ERD Maker

Build and explain entity–relationship diagrams in your browser. Choose Chen notation or crow’s-foot tables, add keys and relationships, then share a live room or download a diagram.

No account is required. Each room saves in this browser using IndexedDB. Download a JSON backup before clearing browser data.

## Run and verify

```bash
npm install
npm run dev
npm run verify
```

The verification suite runs unit tests, TypeScript, a production build, and browser tests. Browser tests start Vite preview and a local y-webrtc signaling server; they do not depend on a public service.

## Build a diagram

Use **Add your first entity** or **Open an example**. The examples cover Customer–Order (one-to-many), Student–Course (many-to-many), and Employee–Dependent (a weak entity). Each opens in a separate room and can be edited.

The Build panel adds entities, attributes, relationships, and specializations. Creating a shape selects its name for typing. Entity properties include **Add attribute** and a key toggle beside each owned attribute.

Relationship properties list participants. Choose an entity for each row, then set its cardinality and optional or required participation. **Minimum / maximum** accepts whole numbers and N for an unlimited maximum. Unfinished or invalid input stays local until corrected. Relationships can remain incomplete or have more than two participants.

Use **Diagram** to search every shape and center a selection. **Check diagram** offers hints for missing names and keys, unattached attributes, incomplete relationships, and invalid participation ranges. Selecting a hint opens the affected properties. Help explains notation and keyboard shortcuts alongside the canvas.

At 1100px and wider, Build/Diagram and Properties sit beside the canvas. Tablets use side drawers. Phones use Build, Diagram, Properties, and Help sheets that scroll above the on-screen keyboard.

**Auto-arrange** spaces the model using the current renderer’s dimensions. **Fit** frames it. Undo and Redo apply to your edits; remote changes remain shared. Deleting a shape also offers Undo feedback.

## Notation

| Chen symbol | Meaning |
| --- | --- |
| Rectangle | Entity |
| Ellipse | Attribute |
| Diamond | Relationship |
| Triangle | Specialization |
| Double rectangle | Weak entity |
| Double diamond | Identifying relationship |
| Double ellipse | Multivalued attribute |
| Dashed ellipse | Derived attribute |
| Underlined attribute | Key |

A weak entity’s partial key identifies it within its parent; SQL export combines it with the parent’s key.

Crow’s-foot tables show source attributes as editable rows. Rows marked **gen** are generated keys or foreign keys. Column types are inferred from names. One-to-one relationships use bars; many ends use a fan; optional participation uses a circle.

Create relationships through Properties in either view. In Chen, you can also use Connect or Shift-click. Concepts absent from the table view, including specializations and attributes on relationships, remain in Diagram; selecting one switches your view to Chen.

Each collaborator chooses a notation independently. The choice is stored locally for that room. JSON files and share snapshots retain the existing `view` field and use the exporting person’s current notation.

## Documents and sharing

New diagrams, examples, and imported JSON files open in separate rooms. Browser Back returns to the previous room and restores its saved work. An invalid import shows a recovery message and leaves the current room intact.

A share link contains the room code and a compressed diagram snapshot, so it can open with nobody online. People with the link can edit the room. If copying is blocked, select the link and copy it manually.

Same-browser tabs sync over BroadcastChannel. Separate browsers use WebRTC; a signaling server introduces peers. Presence comes from connected peers and is shown separately from browser storage.

The default signaling server is `wss://signaling.fly.dev`. Override it using `?signaling=`, `window.__ERD_SIGNALING__`, or `VITE_SIGNALING`. If the network blocks direct connections, the editor and snapshot links still work, but cross-device live edits will not arrive.

## Export

Download SVG, PNG, JSON, or SQL. Image exports use the complete drawing bounds and remove selection, hover, connection, and presence overlays.

SQL follows the existing textbook mapping: entities become tables, weak entities borrow their parent’s key, many-to-many relationships become junction tables, and one-to-many relationships add foreign keys. Types are inferred; custom database types and SQL/DBML import are outside this editor’s current scope.

## Keyboard

| Key | Action |
| --- | --- |
| E / A / R / S | Add entity / attribute / relationship / specialization |
| V / C / H | Select / Connect (Chen) or add relationship (tables) / Pan |
| F | Fit diagram |
| Shift-click two shapes | Connect in Chen |
| Escape | Finish typing, then cancel selection or connection |
| Delete | Delete selection |
| Ctrl or ⌘ + Z | Undo |
| Ctrl or ⌘ + Shift + Z | Redo |
| Ctrl or ⌘ + S | Download JSON |
| ? | Open Help |

The keyboard journey for a two-entity keyed schema is kept within 11 deliberate interactions.

## Design references

The workspace retains IBM Plex typography, paper-and-ink surfaces, quiet drafting grids, and teal selection. It follows the system’s light or dark theme and respects reduced motion.

The teaching reference is [ERDPlus](https://erdplus.com/). Discoverable editing and examples were informed by [drawDB](https://www.drawdb.app/), keyboard efficiency by [dbdiagram’s editing guide](https://docs.dbdiagram.io/basic-editing-experience/), and visible peer state by [DrawSQL’s collaboration documentation](https://drawsql.app/docs/real-time-collaboration). These references guide the workflow; the React/CSS/SVG/Yjs implementation and serialized diagram model remain in place.
