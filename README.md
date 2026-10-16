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

In Chen, choose **Connect** and drag from one entity to another. The editor creates a relationship diamond with both participants, opens its name for editing, and lets you undo the whole connection at once. Connect to an existing diamond to add another participant.

In crow’s-foot, choose **Connect** (C) and click or tap two attribute rows, or drag between them. The new relationship joins those exact rows. Change either endpoint with **Connection attribute** in its properties; **Automatic** follows the inferred key and foreign key. Real foreign-key attributes remain editable, and generated rows are labeled **gen**. Connections follow their attributes through renaming and table movement, and are retained in saved files and share links.

Use **Diagram** to search every shape and center a selection. **Check diagram** offers hints for missing names and keys, unattached attributes, incomplete relationships, and invalid participation ranges. Selecting a hint opens the affected properties. Help explains notation and keyboard shortcuts alongside the canvas.

The canvas fills the workspace. Open Build, Diagram, Properties, or Help from the compact controls on the left; opening or closing panels preserves your drawing position. On phones, **Add**, **Diagram**, **Edit**, and **Help** sit along the bottom instead of covering the left side. Scrollable editing sheets occupy at most 45% of the screen, with **Done** to return to the drawing; Select, Connect, Pan, Undo, and Redo remain available below them. Sheets stay above the on-screen keyboard. Selecting a shape highlights it; use Properties (Edit on phones) or right-click **Edit properties** to edit. New shapes still open their names for typing. Use **Fit** when you want to frame the drawing around an open panel.

Use **Focus view** (I) to hide the controls and spend the whole screen on the diagram. Pan, zoom, shortcuts, and the right-click menu keep working. Press Escape or I, or use **Exit Focus view**, to return. Creating a shape or requesting properties brings the editing controls back.

The **Diagram actions** menu contains New, Import, examples, Export, Share, and Help. Export and Share also appear directly in the desktop header.

**Auto-arrange** spaces the model using the current renderer’s dimensions. **Fit** frames it. Undo and Redo apply to your edits; remote changes remain shared. Deleting a shape also offers Undo feedback.

Right-click empty canvas to add a shape at that point. Right-click a shape, attribute row, or relationship line for its properties, grouping, and deletion actions. Shift-click selects several shapes; right-clicking a selected shape preserves that selection. Open the same menu with **Shift+F10** or the **Menu key** while the canvas is focused. Arrow keys navigate, Enter activates, and Escape or Tab closes it.

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

Chen relationships use ERDPlus-style symbols at the entity endpoints: two bars for required one, a circle and bar for optional one, a bar and fork for required many, and a circle and fork for optional many. N and M both use the fork. Advanced numeric ranges remain visible beside the line. Click an endpoint symbol to edit its constraints.

Crow’s-foot tables show source attributes as editable rows. Generated keys and foreign keys are marked `gen`; an existing `id` attribute stays editable when its primary-key role is generated. Tables are as wide as their longest name or column, so nothing is truncated. Select an attribute and open Properties to choose its **Data type**. **Automatic** infers the type from its name. Foreign-key types follow the referenced field. A type is a base plus, where the database type has one, its numbers — so `VARCHAR` is chosen with a length and `DECIMAL` with a precision and a scale, rather than picked from a list of fixed presets that could only ever contain a few of each. Bases include integers, text, character strings, numeric, boolean, date/time, UUID, JSON, bytea, and enum. `ENUM` takes a comma-separated list of values, shown and exported in SQL form (`ENUM('pending','active','closed')`); quotes in the field are optional and are added on export, and an embedded quote is escaped so the SQL stays valid. A bare base takes its usual default; a number nobody meant (`VARCHAR(0)`, a scale wider than its precision) is refused rather than repaired into something plausible. Chosen types persist through edits, collaboration, JSON, snapshot links, and SQL export. Crow's-foot connectors use bars for one, forks for many, and circles for optional participation, with 1, N, or M labels beside their table endpoints — the relationship's name is not drawn on the connector, so the notation stays legible at a glance. Participation limits remain editable in Properties.

Crow’s-foot table positions are shared with collaborators and stored separately from Chen positions. Dragging or arranging tables never moves the Chen entities or their attributes. New tables keep the position requested on the canvas; tables without a saved position receive a free slot without rearranging existing tables. Line controls follow dbdiagram’s section-based manual editing: hover to reveal a round handle at each section’s midpoint and two small square insertion handles, one on either side. Drag a round handle or the section itself perpendicular to the line: horizontal sections move up or down; vertical sections move left or right. Drag a square to split at the midpoint and move the chosen half independently. Clicking selects without adding a preset bend; Enter on a square adds a section for keyboard editing. Turns are rounded where clearance allows. Use the visible reset arrow to restore automatic routing. Handles support arrow keys, with Shift for a larger move. Each segment moves within a safe route. Endpoint stubs protect the symbols; edits that cross a table or fold the line over itself are blocked. Escape cancels a drag. **Route line automatically** restores automatic routing. Segment positions sync with collaborators and survive reloads and saved files.

Entities have Regular, Weak, and Associative types. Regular keeps the existing strong-entity document value; Weak has a double border; Associative has a diamond inside its rectangle and retains editable attributes, keys, and foreign-key connections. Select an entity and choose Add unary relationship in Properties or its context menu to create two participant roles of the same entity. Chen places the diamond above the entity with bent role lines and separate vertical endpoint stubs; table view draws a loop, and SQL supports self-referencing keys and many-to-many junctions.

Composite attributes can own parts. Select a composite in Properties and use **Add attribute**, or attach an existing attribute through **Belongs to**. Parts can contain further composites. Chen draws the hierarchy and carries descendants when their parent moves. Crow’s-foot tables and SQL use leaf parts with parent-prefixed names, such as `billing_address_street`, preserving each leaf’s key and data type. A composite with no parts retains its scalar column. Move or delete all parts before changing a composite to another kind; deleting it deletes its entire subtree, and Undo restores it.

Create relationships through Properties in either view. In Chen, you can also use Connect. Concepts absent from the table view, including specializations and attributes on relationships, remain in Diagram; selecting one switches your view to Chen.

Each collaborator chooses a notation independently. The choice is stored locally for that room. JSON files and share snapshots retain the existing `view` field and use the exporting person’s current notation.

## Documents and sharing

New diagrams and examples open in separate rooms. Browser Back returns to the previous room and restores its saved work. Importing a JSON file replaces the diagram **in the room you are already in**, so anyone else in that room receives it too; Undo brings the previous diagram back in one step. An invalid import shows a recovery message and leaves the current room intact.

Share defaults to a short URL containing only the room code. Keep the diagram open until the other person joins; live peers send them the document. Someone who opens that link before you are online sees **Waiting for the diagram** and your room code rather than an empty canvas, so the difference between "not arrived yet" and "your link is broken" is obvious. Select **Include diagram snapshot** for a longer portable link that opens a copy even with nobody online. Snapshot links carry the diagram as compressed rows rather than objects, which is roughly 40% shorter than earlier links. People with either link can edit the room. If copying is blocked, select the link and copy it manually.

Same-browser tabs sync over BroadcastChannel. Separate browsers use WebRTC; a signaling server introduces peers. Presence comes from connected peers and is shown separately from browser storage. Closing a tab announces the departure, so a collaborator's cursor and name disappear at once instead of lingering.

An empty diagram offers **Your name** before anything is drawn, because two people in a room both getting an animal name is how nobody can say which arrow is which. It is stored in that browser rather than the diagram, so it applies in every room, and reaches collaborators as you type. A peer's cursor is drawn only for somebody reading the same notation: the two views place one schema at different coordinates, so an arrow from the other one would point at nothing.

**Keeping a copy.** Because there is no server, a diagram lives in the room it was made in and in this browser. **Save a copy** in the Share dialog writes it as a JSON file: it needs nobody online, it is not a link that a chat app can truncate, and whoever receives it opens it with Import. Ctrl+S and Export do the same thing. A short link plus someone staying online is the only way to collaborate live.

The default signaling server is `wss://signaling.fly.dev`. Override it using `?signaling=`, `window.__ERD_SIGNALING__`, or `VITE_SIGNALING`. If the network blocks direct connections, the editor and snapshot links still work, but cross-device live edits will not arrive.

## Export

Download SVG, PNG, JSON, or SQL. Image exports use the complete drawing bounds and remove selection, hover, connection, and presence overlays.

SQL follows the existing textbook mapping: entities become tables, weak entities borrow their parent’s key, many-to-many relationships become junction tables, and one-to-many relationships add foreign keys. Selected connection attributes supply the actual foreign-key columns; explicit one-to-one connections also enforce uniqueness. SQL export explains when a chosen reference needs a single-column primary key, or an endpoint is no longer available. Foreign-key types follow the referenced key; other types use the chosen Data type or infer it from the name. Types are parameterised (`VARCHAR(64)`, `NUMERIC(12,4)`) rather than arbitrary, and SQL/DBML import is outside this editor’s current scope.

## Keyboard

Scroll over the canvas to zoom smoothly toward the pointer. Trackpad pinch and two-finger touch pinch also zoom; moving the pinch midpoint pans the drawing. Zoom stays between 25% and 300%. Editing panels retain their normal scrolling.

| Key | Action |
| --- | --- |
| E / A / R / S | Add entity / attribute / relationship / specialization |
| V / C / H | Select / Connect / Pan |
| F | Fit diagram |
| I | Toggle Focus view |
| Shift-click | Add to or remove from the selection |
| Shift-drag empty canvas | Select several shapes with a box |
| Shift+F10 / Menu key | Open canvas actions |
| Escape | Finish typing, then cancel selection or connection |
| Delete | Delete selection |
| Ctrl or ⌘ + Z | Undo |
| Ctrl or ⌘ + Shift + Z | Redo |
| Ctrl or ⌘ + S | Download JSON |
| ? | Open Help |

The keyboard journey for a two-entity keyed schema is kept within 11 deliberate interactions.

## Design references

The workspace retains IBM Plex typography, paper-and-ink surfaces, quiet drafting grids, and teal selection. It follows the system’s light or dark theme and respects reduced motion. Help also offers **Solarized Light**, **Solarized Dark**, **Dracula**, **Nord**, **GitHub Dark**, and **Monokai** — palettes other tools already ship, using the values those projects publish, so a theme is recognizable before it is read. A theme is a sheet of paper and the ink on it: only the colour tokens change, and every palette is held to the same 4.5:1 body-text contrast as the default. The choice is stored in that browser; picking System clears it and goes back to following the machine.

The teaching reference is [ERDPlus](https://erdplus.com/). Discoverable editing and examples were informed by [drawDB](https://www.drawdb.app/), keyboard efficiency by [dbdiagram’s editing guide](https://docs.dbdiagram.io/basic-editing-experience/), and visible peer state by [DrawSQL’s collaboration documentation](https://drawsql.app/docs/real-time-collaboration). These references guide the workflow; the React/CSS/SVG/Yjs implementation and serialized diagram model remain in place.
