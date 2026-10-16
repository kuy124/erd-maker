import { useMemo, useState, type ReactNode } from 'react';
import { CardinalityMarker, ShapeGlyph } from '../canvas/NodeShapes';
import { EXAMPLES, createExample } from '../model/examples';
import { getDiagramIssues } from '../model/issues';
import type { ErdDocument } from '../model/types';
import type { EditorState } from '../state/useEditor';
import { Modal } from './Modals';
import { applyTheme, savedTheme, THEMES, type ThemeId } from './theme';

export function DiagramOutline({ state, onSelect }: { state: EditorState; onSelect: (id: string) => void }) {
  const [search, setSearch] = useState('');
  const [checksOpen, setChecksOpen] = useState(false);
  const issues = useMemo(() => getDiagramIssues(state.doc), [state.doc]);
  const items = [
    ...state.doc.entities.map((node) => ({ ...node, label: node.name, kind: 'Entity' })),
    ...state.doc.relationships.map((node) => ({ ...node, label: node.name, kind: 'Relationship' })),
    ...state.doc.attributes.map((node) => ({ ...node, label: node.name, kind: 'Attribute' })),
    ...state.doc.isas.map((node) => ({ ...node,
      label: 'Specialization of ' + (state.doc.entities.find((entity) => entity.id === node.parentId)?.name || 'an entity'),
      kind: 'Specialization' })),
  ].filter((node) => (node.label + ' ' + node.kind).toLowerCase().includes(search.toLowerCase().trim()));
  return (
    <div className="outline">
      <label className="field__label" htmlFor="outline-search">Find a shape</label>
      <input id="outline-search" className="field__input" type="search" value={search}
        placeholder="Name or shape type" onChange={(event) => setSearch(event.target.value)} />
      <p className="field__help">Choose a shape to center it and edit its properties.</p>
      <ul className="outline__list">
        {items.map((item) => (
          <li key={item.id}>
            <button type="button" className="outline__item" aria-pressed={state.selection.includes(item.id)}
              onClick={() => onSelect(item.id)}>
              <span>{item.label || 'Unnamed shape'}</span><span className="outline__kind">{item.kind}</span>
            </button>
          </li>
        ))}
      </ul>
      {items.length === 0 ? <p className="note">{search ? 'No matching shapes.' : 'Your shapes will appear here.'}</p> : null}
      <div className="diagram-checks">
        <button type="button" className="btn" aria-expanded={checksOpen} onClick={() => setChecksOpen(!checksOpen)}>
          Check diagram <span className="count">{issues.length}</span>
        </button>
        {checksOpen ? (
          <>
            <p className="field__help">Common modeling hints. You can keep drawing while you review them.</p>
            {issues.length === 0 ? <p className="note">No common modeling issues found.</p> : (
              <ul className="outline__list">
                {issues.map((issue) => <li key={issue.code + issue.nodeId}>
                  <button type="button" className="issue-link" onClick={() => onSelect(issue.nodeId)}>{issue.message}</button>
                </li>)}
              </ul>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Theme choice.
 *
 * A radio group rather than a menu of buttons: these are exclusive options, and
 * arrow-key navigation plus a single announced state comes free with a radiogroup
 * that a row of toggles would have to be taught.
 */
/**
 * Theme choice.
 *
 * A radio group rather than a menu of buttons: these are exclusive options, and
 * arrow-key navigation plus a single announced state come free with a radiogroup
 * that a row of toggles would have to be taught. Each swatch carries its own
 * theme on a `data-theme` attribute, so the chip shows the real palette instead
 * of a word that has to be read before it can be judged.
 */
export function ThemePicker() {
  const [theme, setTheme] = useState<ThemeId>(savedTheme);
  const choose = (next: ThemeId) => {
    setTheme(next);
    applyTheme(next);
  };
  return (
    <div role="radiogroup" aria-label="Theme" className="theme-picker__options">
      {THEMES.map((option) => (
        <button key={option.id} type="button" role="radio" aria-checked={theme === option.id}
          className="theme-swatch" data-theme={option.id === 'system' ? undefined : option.id}
          onClick={() => choose(option.id)}>
          <span className="theme-swatch__chip" aria-hidden="true" />
          <span className="theme-swatch__text">
            <strong>{option.name}</strong>
            <span>{option.note}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * A collapsible block of the guide.
 *
 * The guide covers a lot of ground, and a reader arrives looking for one thing.
 * Sections start open so the answers are visible on arrival, and a heading can
 * be collapsed to get a topic out of the way once it is understood. Native
 * `<details>` gives the toggle, the keyboard behaviour, and the state for free.
 */
function HelpSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="help-section" open>
      <summary className="help-section__summary"><h3>{title}</h3></summary>
      <div className="help-section__body">{children}</div>
    </details>
  );
}

export function HelpPanel() {
  return (
    <section className="help-panel" aria-label="Modeling guide">
      <h2 className="panel__title">Modeling guide</h2>
      <p className="help-intro">
        A quick reference, not a tutorial: read the part you need. Every heading
        collapses once you have it.
      </p>

      <HelpSection title="The four shapes">
        <dl className="help-legend">
          {[
            ['entity', 'Entity', 'A thing you keep records about, such as a customer.'],
            ['attribute', 'Attribute', 'A fact about an entity, such as email. A key identifies a record and is underlined.'],
            ['relationship', 'Relationship', 'A named link between entities, such as places.'],
            ['isa', 'Specialization', 'A superclass and its subtypes, such as Employee with Salaried and Hourly.'],
          ].map(([kind, name, description]) => (
            <div key={kind}>
              <dt><ShapeGlyph kind={kind as 'entity' | 'attribute' | 'relationship' | 'isa'} />{name}</dt>
              <dd>{description}</dd>
            </div>
          ))}
        </dl>
        <p>Start with the things you keep records about, add their attributes and keys, then describe how they relate.</p>
      </HelpSection>

      <HelpSection title="Attribute kinds">
        <dl className="help-legend">
          <div>
            <dt>Multivalued</dt>
            <dd>A double ellipse. The attribute can hold more than one value, such as several phone numbers.</dd>
          </div>
          <div>
            <dt>Derived</dt>
            <dd>A dashed ellipse. Calculated rather than stored, such as an age from a birth date. Left out of tables and SQL.</dd>
          </div>
          <div>
            <dt>Composite</dt>
            <dd>Made of smaller parts, such as an address made of street and city.</dd>
          </div>
        </dl>
        <p>To build a composite, select it and use <strong>Add attribute</strong> in Properties, or attach an existing attribute to it. Parts can hold further parts. Tables and SQL use the leaf parts with the parent name, such as <code>address_street</code>.</p>
      </HelpSection>

      <HelpSection title="Read a relationship">
        <div className="relationship-example">Customer <strong>1</strong> — places — <strong>N</strong> Order</div>
        <p>One customer places many orders; each order belongs to one customer. N and M both mean many.</p>
        <p><strong>Participation</strong> says whether every instance must take part: minimum 0 is optional, minimum 1 is required, and a maximum of N means no fixed upper limit.</p>
        <div className="endpoint-examples">
          {[[false, true, 'Required one'], [false, false, 'Optional one'],
            [true, true, 'Required many'], [true, false, 'Optional many']].map(([many, required, label]) => (
            <div key={String(label)}>
              <svg width={84} height={28} viewBox="0 0 84 28" aria-hidden="true">
                <line className="leg" x1={8} y1={14} x2={78} y2={14} />
                <CardinalityMarker origin={{ x: 8, y: 14 }} toward={{ x: 78, y: 14 }}
                  many={Boolean(many)} required={Boolean(required)} />
              </svg><span>{label}</span>
            </div>
          ))}
        </div>
        <p>The symbol beside an entity describes that entity. Click it to edit its cardinality and participation.</p>
      </HelpSection>

      <HelpSection title="Build and edit">
        <ul className="help-list">
          <li><strong>Add a shape</strong> — press E, A, R, or S, or right-click the canvas to place one at the pointer.</li>
          <li><strong>Edit a shape</strong> — select it and open Properties, or double-click it.</li>
          <li><strong>Connect entities</strong> — choose Connect (C) and drag from one entity to another. The diamond is created for you; drag to an existing diamond to add another participant.</li>
          <li><strong>Select several</strong> — Shift-click, or Shift-drag a box on empty canvas.</li>
        </ul>
      </HelpSection>

      <HelpSection title="Entity types and unary relationships">
        <ul className="help-list">
          <li><strong>Regular</strong> — the default.</li>
          <li><strong>Weak</strong> — a double border. Identified by a parent entity through an identifying relationship (a double diamond).</li>
          <li><strong>Associative</strong> — a rectangle with a diamond inside. Stores attributes of an association.</li>
        </ul>
        <p>A <strong>unary</strong> relationship links an entity to itself: select it and choose <strong>Add unary relationship</strong>. The entity takes two roles, such as Employee managing Employee, each with its own cardinality in Participants.</p>
      </HelpSection>

      <HelpSection title="Crow’s-foot tables">
        <p>The table view shows the same model as tables. Bars mean one, forks mean many, and circles mean optional participation. Each table end shows its own cardinality: 1, N, or M.</p>
        <p>Choose Connect (C) and click or tap two attribute rows to link them, or drag between them. Change either end with its <strong>Connection attribute</strong> selector; <strong>Automatic</strong> follows the inferred key and foreign key.</p>
        <p className="help-label">Dragging a connector line</p>
        <ul className="help-list">
          <li>Drag a <strong>round handle</strong> to move that section of the line, or a <strong>square</strong> to split it there.</li>
          <li>Use <strong>arrow keys</strong> on a selected line, with Shift for a larger step.</li>
          <li>Use the <strong>reset arrow</strong> to restore automatic routing; Escape cancels a drag.</li>
          <li>A drag that would cross a table stops at its last safe position.</li>
        </ul>
        <p className="help-label">Data types</p>
        <ul className="help-list">
          <li>Choose one in Properties, or leave it <strong>Automatic</strong> to infer the type from the name.</li>
          <li>Foreign keys inherit the type of the field they reference. <code>ENUM</code> takes a comma-separated list of values.</li>
        </ul>
      </HelpSection>

      <HelpSection title="Chen and crow’s-foot">
        <p>Both views show the same entities, attributes, and relationships; you can switch at any time.</p>
        <p>Specializations, derived attributes, and attributes on relationships appear in Chen only. Many-to-many associations become their own table in SQL.</p>
        <p>SQL export offers a dialect — Standard, PostgreSQL, MySQL, or SQLite — which changes only how generated key columns are spelled.</p>
      </HelpSection>

      <HelpSection title="Keyboard shortcuts">
        <p><strong>Focus view</strong> (I) hides the controls to give the diagram the whole screen; press Escape or I to leave.</p>
        <p>Right-click the canvas to add a shape, or right-click a shape or line to edit, group, or delete it.</p>
        <dl className="shortcut-list">
          {[['E / A / R / S', 'Add entity, attribute, relationship, specialization'],
            ['V / C / H', 'Select, connect, pan'], ['F', 'Fit diagram'],
            ['I', 'Enter or exit Focus view'],
            ['Shift + click', 'Add to or remove from the selection'],
            ['Shift + drag', 'Draw a box around several shapes'],
            ['Shift + F10 / Menu key', 'Open canvas actions for the focused shape or selection'],
            ['Escape', 'Finish typing, cancel, or clear the selection'],
            ['Delete', 'Delete everything selected'], ['Ctrl / ⌘ + Z', 'Undo'], ['Ctrl / ⌘ + Shift + Z', 'Redo'],
            ['Ctrl / ⌘ + S', 'Download a diagram file']].map(([key, action]) => (
            <div key={key}><dt><kbd>{key}</kbd></dt><dd>{action}</dd></div>
          ))}
        </dl>
      </HelpSection>
    </section>
  );
}

export function ExamplesDialog({ onOpen, onClose }: { onOpen: (doc: ErdDocument) => void; onClose: () => void }) {
  return (
    <Modal title="Open an example" onClose={onClose}>
      <p className="note" style={{ marginTop: 0 }}>Each example opens as a separate, editable diagram. Your current diagram stays in its room.</p>
      <div className="examples">
        {EXAMPLES.map((example) => (
          <button type="button" className="example-row" key={example.id} onClick={() => onOpen(createExample(example.id))}>
            <span className="example-row__ratio">{example.ratio}</span>
            <span><strong>{example.name}</strong><span className="example-row__description">{example.description}</span></span>
            <span aria-hidden="true">→</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
