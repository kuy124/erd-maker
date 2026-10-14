import { useMemo, useState } from 'react';
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

export function HelpPanel() {
  return (
    <section className="help-panel" aria-label="Modeling guide">
      <h2 className="panel__title">Modeling guide</h2>
      <p>Start with the things you keep records about. Add their attributes, choose keys, then describe how the entities relate.</p>
      <dl className="help-legend">
        {[
          ['entity', 'Entity', 'A thing you track, such as a customer. A weak entity uses a double rectangle and needs a parent to identify it.'],
          ['attribute', 'Attribute', 'A fact such as email. A key uniquely identifies a record and is underlined.'],
          ['relationship', 'Relationship', 'A named association, such as places. An identifying relationship uses a double diamond and joins a weak entity to its parent.'],
          ['isa', 'Specialization', 'A superclass and its subtypes, such as Employee with Salaried and Hourly subclasses.'],
        ].map(([kind, name, description]) => (
          <div key={kind}>
            <dt><ShapeGlyph kind={kind as 'entity' | 'attribute' | 'relationship' | 'isa'} />{name}</dt>
            <dd>{description}</dd>
          </div>
        ))}
      </dl>
      <h3>Attribute kinds</h3>
      <p>Multivalued attributes have a double ellipse; derived attributes have a dashed ellipse. A composite attribute describes smaller parts, such as an address.</p>
      <p>Select a composite and use Add attribute in Properties to create its parts, such as Street and City. Parts can also be composite. Chen draws each part linked to its parent; tables and SQL use the leaf parts with parent names, such as address_street. Move or delete the parts before changing a composite’s kind.</p>
      <h3>Read a relationship</h3>
      <div className="relationship-example">Customer <strong>1</strong> — places — <strong>N</strong> Order</div>
      <p>One customer can place many orders. Each order belongs to one customer. N and M both mean many.</p>
      <p>Participation says whether every instance must take part. Minimum 0 is optional; minimum 1 is required. Maximum N means there is no fixed upper limit.</p>
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
      <p>The endpoint beside an entity describes that entity. Click its symbols to edit. N and M use a fork; advanced numeric limits are written beside the line.</p>
      <p>Connect two entities to create a relationship diamond automatically. Connect an entity to an existing diamond to add a participant.</p>
      <p>Entity types are Regular, Weak, and Associative. Weak uses a double border; Associative uses a rectangle with a diamond inside. An associative entity stores attributes of an association and connects to its related entities.</p>
      <p>For a unary relationship, select an entity and choose Add unary relationship in Properties or its right-click menu. The diamond starts above the entity, with two bent role lines and separate endpoint symbols. The entity takes two roles, such as Employee managing Employee. Edit each role’s cardinality and connection attribute in Participants.</p>
      <h3>Chen and crow’s-foot</h3>
      <p>Crow’s-foot table view uses bars for one, forks for many, and circles for optional participation. Each table end shows its own cardinality label: 1, N, or M. Edit its Participants to change these constraints.</p>
      <p>In crow’s-foot view, choose Connect (C) and click or tap two attribute rows, or drag from one row to another. A relationship is created with its endpoints on those rows. Use its Connection attribute selectors to change either end; Automatic follows the inferred key and foreign key.</p>
      <p>Hover a line to reveal its round section handles and small squares on either side. Drag a round handle to move the whole section: horizontal sections move up or down; vertical sections move left or right. Drag a square to split at the midpoint and move that half independently. A click selects without reshaping. Use the reset arrow to restore automatic routing. Select a line with Enter to use its handles with arrow keys, or Shift with an arrow for a larger move; Enter on a square adds a section. Endpoint stubs protect the symbols. A drag that would cross a table or fold the line over itself stops at its last safe position. Escape cancels the drag.</p>
      <p>Both views use the same entities, attributes, and relationships. Choose an attribute’s Data type in Properties, or leave it Automatic to infer from its name. Foreign keys inherit the referenced field’s type; generated rows follow their source keys.</p>
      <p>Specializations, derived attributes, and attributes on relationships are shown in Chen. Many-to-many associations are drawn as connectors; SQL export maps them to junction tables.</p>
      <h3>Keyboard shortcuts</h3>
      <p>Focus view (I) hides the controls while you explore the diagram. Press Escape or I to return. Selecting a shape keeps you on the canvas; open Properties or use right-click Edit properties when you want to change it.</p>
      <p>Right-click empty canvas to add a shape at the pointer. Right-click a shape, attribute row, or relationship line to edit, group, or delete it. Shift-click selects several shapes; right-click one of them to keep that selection.</p>
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
