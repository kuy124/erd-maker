/**
 * The inspector.
 *
 * Shows the selected node's fields, and nothing else. The right panel is the
 * one place where the notation's details (key, multivalued, derived, weak,
 * cardinality, participation) are edited, so those concepts live in exactly one
 * screen region and the canvas stays uncluttered.
 *
 * When nothing is selected it explains what can be selected rather than sitting
 * empty — an empty panel is a missed opportunity to teach the notation.
 */

import { useEffect, useRef, useState } from 'react';
import type { EditorState } from '../state/useEditor';
import type { AttributeKind, ErdDocument } from '../model/types';
import {
  attributeType,
  BASE_TYPES,
  enumValuesFromInput,
  makeDataType,
  makeEnumType,
  MAX_LENGTH,
  MAX_PRECISION,
  splitDataType,
  type BaseType,
} from '../model/dataTypes';

/**
 * The number inputs a base needs, and the bounds each accepts.
 *
 * `DECIMAL(12, 4)` has two numbers because the database type does, so the form
 * asks for two. A scale may be zero — `DECIMAL(12, 0)` is a real type — while a
 * precision of zero is not.
 */
function lengthFields(base: BaseType): Array<{ id: string; base: BaseType; label: string; min: number; max: number; fallback: number }> {
  if (base === 'VARCHAR' || base === 'CHAR') {
    return [{ id: 'attr-type-length', base, label: `${base} length`, min: 1, max: MAX_LENGTH, fallback: 255 }];
  }
  if (base === 'FLOAT') {
    return [{ id: 'attr-type-precision', base, label: 'FLOAT precision', min: 1, max: MAX_PRECISION, fallback: 53 }];
  }
  if (base === 'NUMERIC' || base === 'DECIMAL') {
    return [
      { id: 'attr-type-precision', base, label: `${base} total digits`, min: 1, max: MAX_PRECISION, fallback: 10 },
      { id: 'attr-type-scale', base, label: `${base} decimal places`, min: 0, max: MAX_PRECISION, fallback: 2 },
    ];
  }
  return [];
}

/**
 * The comma-separated list of an `ENUM`, kept as free text while it is typed.
 *
 * The stored type is derived from this text, but the field must not be driven by
 * the stored type: a half-typed list like `red, ` is not yet a valid enum, and
 * echoing the canonical value back would delete the comma the moment it was
 * typed. The text is the source of truth here; the model follows what can be
 * parsed, and holds its last good value while the text is still incomplete.
 */
function EnumValuesField({ id, values, onChange }: {
  id: string;
  values: string[];
  onChange: (type: string) => void;
}) {
  const [text, setText] = useState(values.join(', '));
  // A different attribute (or an external edit that changed the values) resets
  // the field, but only when the values actually differ from what is typed.
  const canonical = values.join(', ');
  const lastCanonical = useRef(canonical);
  useEffect(() => {
    if (lastCanonical.current !== canonical) {
      lastCanonical.current = canonical;
      setText(canonical);
    }
  }, [canonical]);
  return <input key={id} id={id} className="field__input enum-values"
    type="text" autoComplete="off" spellCheck={false}
    aria-label="Enum values" placeholder="e.g. pending, active, closed"
    value={text}
    onChange={(event) => {
      const next = event.target.value;
      setText(next);
      const made = makeEnumType(enumValuesFromInput(next));
      // Hold the last good enum while a value is still being typed, rather than
      // clearing the column's type on the way to a complete list.
      if (made) onChange(made);
    }} />;
}
import { deriveTables } from '../model/crowfoot';
import { canOwnAttribute } from '../model/attributes';
import { ParticipationFields, RelationshipParticipants } from './RelationshipParticipants';

interface Props {
  state: EditorState;
  nameFocusReady?: boolean;
}

const ATTRIBUTE_KINDS: { value: AttributeKind; label: string }[] = [
  { value: 'simple', label: 'Simple' },
  { value: 'key', label: 'Key' },
  { value: 'unique', label: 'Unique' },
  { value: 'multivalued', label: 'Multivalued' },
  { value: 'derived', label: 'Derived' },
  { value: 'composite', label: 'Composite' },
];

/** A short human label for a selected id, used by the multi-selection list. */
function describe(doc: ErdDocument, id: string): string | null {
  const node =
    doc.entities.find((e) => e.id === id) ??
    doc.attributes.find((a) => a.id === id) ??
    doc.relationships.find((r) => r.id === id) ??
    doc.isas.find((i) => i.id === id);
  if (!node) return null;
  return 'name' in node ? node.name || 'Unnamed shape' : 'Specialization';
}

export function Inspector({ state, nameFocusReady = true }: Props) {
  const { doc, selection } = state;

  /**
   * Focus the name field for a shape that was just created.
   *
   * Adding a shape should leave the caret blinking, ready for its name, so the
   * fastest path — press E, type "Customer" — needs no click on this panel.
   *
   * Only for newly created shapes, not for every selection. Focusing on every
   * selection change means clicking any shape on the canvas yanks the caret
   * into the side panel, which fights the user and swallows the next keystroke
   * as text entry.
   */
  const nameRef = useRef<HTMLInputElement | null>(null);
  const superclassRef = useRef<HTMLSelectElement | null>(null);
  useEffect(() => {
    if (true) return; // auto-focus disabled
    const focus = () => {
      const field = nameRef.current ?? superclassRef.current;
      if (!field || document.activeElement === field) return;
      field.focus();
      if (field instanceof HTMLInputElement) field.select();
    };
    focus();
    const frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, [selection, state.justCreated, nameFocusReady]);

  // Everything below the multi-selection panel edits exactly one shape, so the
  // rest of the file reads a single `selection` id.
  const selected = selection.length === 1 ? selection[0] : undefined;
  const entity = doc.entities.find((e) => e.id === selected);
  const attribute = doc.attributes.find((a) => a.id === selected);
  const relationship = doc.relationships.find((r) => r.id === selected);
  const isa = doc.isas.find((i) => i.id === selected);
  const leg = doc.legs.find((l) => l.id === selected);

  if (selection.length > 1) {
    return (
      <aside className="inspector" aria-label="Properties">
        <h2 className="panel__title">{selection.length} shapes selected</h2>
        <p className="inspector__empty">
          Drag any of them to move the whole selection at once. Shift-click a shape to add it, or
          shift-drag empty paper to draw a box around several.
        </p>
        <ul className="inspector__list">
          {selection.map((id) => (
            <li key={id}>
              <button type="button" className="btn btn--ghost" onClick={() => state.setSelection([id])}>
                {describe(doc, id) ?? 'Line'}
              </button>
            </li>
          ))}
        </ul>
        <div className="inspector__actions">
          <button
            type="button"
            className="btn"
            onClick={() => state.group(selection)}
          >
            Group {selection.length} shapes
          </button>
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => state.remove(selection)}
          >
            Delete {selection.length} shapes
          </button>
        </div>
      </aside>
    );
  }

  if (!selection.length) {
    return (
      <aside className="inspector" aria-label="Properties">
        <h2 className="panel__title">Select a shape</h2>
        <p className="inspector__empty">
          Choose one on the canvas or in Diagram. Shift-click for several.
        </p>
      </aside>
    );
  }

  if (entity) {
    const owned = doc.attributes.filter((a) => a.ownerId === entity.id);
    return (
      <aside className="inspector" aria-label="Properties">
        <h2 className="panel__title">Entity</h2>
        <div className="field">
          <label className="field__label" htmlFor="entity-name">
            Entity name
          </label>
          <input
            id="entity-name"
            data-testid="inspector-name"
            ref={nameRef}
            className="field__input"
            defaultValue={entity.name}
            onChange={(event) => state.updateEntity(entity.id, { name: event.target.value })}
            autoComplete="off"
          />
        </div>
        <div className="field">
          <span className="field__label" id="entity-kind-label">
            Entity type
          </span>
          <div className="seg" role="group" aria-labelledby="entity-kind-label">
            <button
              type="button"
              className="seg__btn"
              aria-pressed={entity.kind === 'strong'}
              onClick={() => state.updateEntity(entity.id, { kind: 'strong' })}
            >
              Regular
            </button>
            <button
              type="button"
              className="seg__btn"
              aria-pressed={entity.kind === 'weak'}
              onClick={() => state.updateEntity(entity.id, { kind: 'weak' })}
            >
              Weak
            </button>
            <button type="button" className="seg__btn" aria-pressed={entity.kind === 'associative'}
              onClick={() => state.updateEntity(entity.id, { kind: 'associative' })}>Associative</button>
          </div>
          <p className="field__help">
            {entity.kind === 'weak' ? 'A weak entity depends on its parent and is drawn with a double border.' :
              entity.kind === 'associative' ? 'An associative entity stores facts about an association. Connect it to the related entities and choose its key attributes.' :
                'A regular entity has its own identity, such as a customer or employee.'}
          </p>
          <button type="button" className="btn" onClick={() => state.connect(entity.id, entity.id)}>Add unary relationship</button>
        </div>

        <div className="field">
          <span className="field__label">Attributes ({owned.length})</span>
          {owned.length === 0 ? (
            <p className="field__help">
              {entity.kind === 'weak' ? 'Choose a partial key, such as a name. Combined with the parent’s key, it identifies each dependent record.' :
                'Add a key to identify each ' + (entity.name || 'entity') + ' uniquely, such as an ID or student number.'}
            </p>
          ) : (
            <ul className="attr-list">
              {owned.map((attr) => (
                <li key={attr.id} className="attr-list__item">
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => state.setSelection([attr.id])}
                  >
                    {attr.name || 'Unnamed attribute'}
                  </button>
                  <button type="button" className="btn btn--ghost key-toggle"
                    aria-label={'Key attribute: ' + (attr.name || 'Unnamed attribute')}
                    aria-pressed={attr.kind === 'key'}
                    title="A key uniquely identifies each entity"
                    onClick={() => state.updateAttribute(attr.id, { kind: attr.kind === 'key' ? 'simple' : 'key' })}>
                    Key
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="btn attribute-add" onClick={() => state.addAttribute(entity.x, entity.y, entity.id)}>Add attribute</button>
          {doc.view === 'crowfoot' ? <p className="field__help">Select an attribute to choose its SQL data type. Rows marked “FK” or “PK” with no attribute behind them are generated; foreign keys inherit the referenced type.</p> : null}
        </div>

        <button type="button" className="btn btn--danger" onClick={() => state.remove([entity.id])}>
          Delete entity
        </button>      </aside>
    );
  }

  if (attribute) {
    const owned = doc.attributes.filter(a => a.ownerId === attribute.id);
    const owners = [...doc.entities, ...doc.relationships, ...doc.isas,
      ...doc.attributes.filter(a => a.kind === 'composite')]
      .filter(owner => canOwnAttribute(doc, attribute.id, owner.id));
    const row = doc.view === 'crowfoot' ? deriveTables(doc).flatMap((table) => table.rows).find((r) => r.attributeId === attribute.id) : undefined;
    return (
      <aside className="inspector" aria-label="Properties">
        <h2 className="panel__title">Attribute</h2>
        <div className="field">
          <label className="field__label" htmlFor="attr-name">
            Attribute name
          </label>
          <input
            id="attr-name"
            data-testid="inspector-name"
            ref={nameRef}
            className="field__input"
            defaultValue={attribute.name}
            onChange={(event) => state.updateAttribute(attribute.id, { name: event.target.value })}
            autoComplete="off"
          />
        </div>
        {doc.view === 'crowfoot' ? <div className="field">
          <label className="field__label" htmlFor="attr-data-type">Data type</label>
          {/*
            A base and, for the bases that have one, its arguments — because
            `VARCHAR` and `VARCHAR(64)` are different columns and a list of
            fixed presets can only ever offer a few of each. The extra inputs
            appear only for bases that take them: numbers for `VARCHAR`, a
            comma-separated list for `ENUM`, nothing for `INT`.
          */}
          <div className="type-fields">
            <select id="attr-data-type" className="field__select"
              aria-describedby="attr-data-type-help"
              value={row?.fk ? 'inherited' : (attribute.dataType ? splitDataType(attribute.dataType).base : '')}
              disabled={row?.fk}
              onChange={(event) => {
                const base = event.target.value as BaseType;
                state.updateAttribute(attribute.id, { dataType: makeDataType(base) });
              }}>
              {row?.fk ? <option value="inherited">{row.type} (inherited)</option> : <>
                <option value="">Automatic ({attributeType({ name: attribute.name })})</option>
                {BASE_TYPES.map((base) => <option key={base} value={base}>{base}</option>)}
              </>}
            </select>
            {!row?.fk && lengthFields(splitDataType(attribute.dataType).base).map((field, index) =>
              <input key={field.id} id={field.id} className="field__input field__input--number"
                type="number" inputMode="numeric" aria-label={field.label}
                min={field.min} max={field.max}
                value={splitDataType(attribute.dataType).args[index] ?? field.fallback}
                disabled={splitDataType(attribute.dataType).base !== field.base}
                onChange={(event) => {
                  const current = splitDataType(attribute.dataType);
                  const next = [...current.args];
                  next[index] = event.target.value === '' ? Number.NaN : Number(event.target.value);
                  const made = makeDataType(current.base, next);
                  // Half-typed input holds no number yet. Writing that through
                  // would delete the column's type on the way to a valid one —
                  // clearing `12` and typing `4` passes through 0, and
                  // NUMERIC(12, 0) plus a `4` is a scale wider than its
                  // precision, which is not a type. The last good one stands
                  // until there is a replacement.
                  if (made) state.updateAttribute(attribute.id, { dataType: made });
                }} />)}
            {!row?.fk && splitDataType(attribute.dataType).base === 'ENUM' ?
              <EnumValuesField id="attr-enum-values" values={splitDataType(attribute.dataType).enumValues}
                onChange={(value) => state.updateAttribute(attribute.id, { dataType: value })} /> : null}
          </div>
          <p id="attr-data-type-help" className="field__help">{row?.fk ?
            'Inherited from ' + row.references?.label + '. Change the referenced attribute’s data type to keep this foreign key compatible.' :
            attribute.kind === 'derived' ? 'Derived attributes are calculated and omitted from tables and SQL.' :
            splitDataType(attribute.dataType).base === 'ENUM' ?
              'Type the allowed values, separated by commas. Quotes are optional; each value is quoted in the exported SQL.' :
            'Automatic infers a type from the name. Choose a type to use it in tables and SQL.'}</p>
        </div> : null}
        <div className="field">
          <span className="field__label" id="attr-kind-label">
            Kind
          </span>
          <div className="seg attribute-kinds" role="group" aria-labelledby="attr-kind-label">
            {ATTRIBUTE_KINDS.map((kind) => (
              <button
                key={kind.value}
                type="button"
                className="seg__btn"
                aria-pressed={attribute.kind === kind.value}
                disabled={owned.length > 0 && kind.value !== 'composite'}
                onClick={() => state.updateAttribute(attribute.id, { kind: kind.value })}
              >
                {kind.label}
              </button>
            ))}
          </div>
          <p className="field__help">{attribute.kind === 'key' && doc.entities.some((owner) => owner.id === attribute.ownerId && owner.kind === 'weak') ?
            'This partial key identifies a weak entity within its parent. The same value may occur under a different parent.' : describeKind(attribute.kind)}</p>
          {owned.length > 0 ? <p className="field__help">Move or delete the parts before changing this composite’s kind.</p> : null}
        </div>
        {attribute.kind === 'composite' ? <div className="field">
          <span className="field__label">Parts ({owned.length})</span>
          <ul className="attr-list">
            {owned.map(part => <li className="attr-list__item" key={part.id}>
              <button type="button" className="btn btn--ghost" onClick={() => state.setSelection([part.id])}>
                {part.name || 'Unnamed attribute'}
              </button>
            </li>)}
          </ul>
          <button type="button" className="btn attribute-add"
            onClick={() => state.addAttribute(attribute.x, attribute.y, attribute.id)}>Add attribute</button>
          <p className="field__help">Parts can also be composite. Tables and SQL use the leaf parts with their parent names.</p>
        </div> : null}
        <div className="field">
          <label className="field__label" htmlFor="attr-owner">
            Belongs to
          </label>
          <select
            id="attr-owner"
            className="field__select"
            value={attribute.ownerId ?? ''}
            onChange={(event) =>
              state.updateAttribute(attribute.id, { ownerId: event.target.value || null })
            }
          >
            <option value="">Nothing yet</option>
            {owners.map((owner) => (
              <option key={owner.id} value={owner.id}>
                {'name' in owner ? owner.name : 'Specialization'}
              </option>
            ))}
          </select>
          <p className="field__help">
            An attribute with no owner floats free. Attaching it draws a line to the shape it describes.
          </p>
        </div>
        <button type="button" className="btn btn--danger" onClick={() => state.remove([attribute.id])}>
          Delete attribute
        </button>
      </aside>
    );
  }

  if (relationship) {
    return (
      <aside className="inspector" aria-label="Properties">
        <h2 className="panel__title">Relationship</h2>
        <div className="field">
          <label className="field__label" htmlFor="rel-name">
            Relationship name
          </label>
          <input
            id="rel-name"
            data-testid="inspector-name"
            ref={nameRef}
            className="field__input"
            value={relationship.name}
            onChange={(event) => state.updateRelationship(relationship.id, { name: event.target.value })}
            autoComplete="off"
          />
        </div>
        <div className="field">
          <span className="field__label" id="rel-kind-label">
            Kind
          </span>
          <div className="seg" role="group" aria-labelledby="rel-kind-label">
            <button
              type="button"
              className="seg__btn"
              aria-pressed={relationship.kind === 'strong'}
              onClick={() => state.updateRelationship(relationship.id, { kind: 'strong' })}
            >
              Strong
            </button>
            <button
              type="button"
              className="seg__btn"
              aria-pressed={relationship.kind === 'weak'}
              onClick={() => state.updateRelationship(relationship.id, { kind: 'weak' })}
            >
              Identifying
            </button>
          </div>
          <p className="field__help">
            An identifying relationship connects a weak entity to its parent, and is drawn with a double
            border.
          </p>
        </div>
        {/*
          Route control, Crow's-foot only.

          The router picks the shorter side when a connector cannot go straight,
          which is usually right and sometimes sends the line out of the drawing.
          This is the override for that case, and Automatic is the default so
          nobody has to think about it.
        */}
        {doc.view === 'crowfoot' ? <div className="field">
          <span className="field__label" id="rel-route-label">Line route</span>
          <div className="seg" role="group" aria-labelledby="rel-route-label">
            {([['auto', 'Automatic'], ['above', 'Above'], ['below', 'Below']] as const).map(([side, label]) => (
              <button
                key={side}
                type="button"
                className="seg__btn"
                data-testid={`rel-route-${side}`}
                aria-pressed={relationship.bendX === undefined && !relationship.routePoints && (relationship.route ?? 'auto') === side}
                onClick={() => state.updateRelationship(relationship.id, { route: side, bendX: undefined, bendY: undefined, routePoints: undefined }, true)}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="field__help">
            Above and Below choose a detour. Automatic clears a dragged bend and lets the router choose.
          </p>
        </div> : null}
        <RelationshipParticipants key={relationship.id} state={state} relationshipId={relationship.id} />
        <button type="button" className="btn btn--danger" onClick={() => state.remove([relationship.id])}>
          Delete relationship
        </button>
      </aside>
    );
  }

  if (isa) {
    const entities = doc.entities;
    return (
      <aside className="inspector" aria-label="Properties">
        <h2 className="panel__title">Specialization</h2>
        <div className="field">
          <label className="field__label" htmlFor="isa-parent">
            Superclass
          </label>          <select
            id="isa-parent"
            ref={superclassRef}
            className="field__select"
            value={isa.parentId ?? ''}
            onChange={(event) => state.updateIsaParent(isa.id, event.target.value || null)}
          >
            <option value="">None</option>
            {entities.map((entity) => (
              <option key={entity.id} value={entity.id}>
                {entity.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <span className="field__label">Subclasses ({isa.childIds.length})</span>
          {entities.length === 0 ? (
            <p className="field__help">Add entities first, then pick the ones that are subtypes.</p>
          ) : (
            <ul className="attr-list">
              {entities.map((entity) => (
                <li key={entity.id} className="attr-list__item">
                  <label className="attr-list__name" htmlFor={`isa-child-${entity.id}`}>
                    {entity.name}
                  </label>
                  <input
                    id={`isa-child-${entity.id}`}
                    type="checkbox"
                    checked={isa.childIds.includes(entity.id)}
                    onChange={(event) => state.updateIsaChildren(isa.id, entity.id, event.target.checked)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
        <button type="button" className="btn btn--danger" onClick={() => state.remove([isa.id])}>
          Delete specialization
        </button>
      </aside>
    );
  }

  if (leg) {
    const entity = doc.entities.find((node) => node.id === leg.fromId || node.id === leg.toId);
    const relationship = doc.relationships.find((node) => node.id === leg.fromId || node.id === leg.toId);
    return (
      <aside className="inspector" aria-label="Properties">
        <h2 className="panel__title">Relationship line</h2>
        <div className="field">
          <span className="field__label" id="leg-card-label">
            Cardinality at {entity?.name || 'this endpoint'}
          </span>
          <div className="seg" role="group" aria-labelledby="leg-card-label">
            {(['1', 'N', 'M'] as const).map((card) => (
              <button
                key={card}
                type="button"
                className="seg__btn"
                aria-pressed={leg.cardinality === card}
                onClick={() => state.updateLeg(leg.id, { cardinality: card })}
              >
                {card}
              </button>
            ))}
          </div>
          <p className="field__help">
            {entity?.name || 'This endpoint'} contributes {leg.cardinality === '1' ? 'one' : 'many'} to {relationship?.name || 'this connection'}. Use the relationship’s participant list to see the full ratio.
          </p>
        </div>
        <div className="field">
          <span className="field__label">Participation</span>
          <ParticipationFields key={leg.id} value={leg.participation}
            onChange={(value) => state.updateLeg(leg.id, { min: value.min, max: value.max })} />
          <p className="field__help">
            A circle means optional; a bar means required. A fork means many. Exact numeric ranges also appear beside the line.
          </p>
        </div>
        <button type="button" className="btn btn--danger" onClick={() => state.remove([leg.id])}>
          Delete line
        </button>
      </aside>
    );
  }

  return (
    <aside className="inspector" aria-label="Properties">
      <h2 className="panel__title">Properties</h2>
      <p className="inspector__empty">That shape is no longer in the diagram.</p>
    </aside>
  );
}

function describeKind(kind: AttributeKind): string {
  switch (kind) {
    case 'key':
      return 'A key uniquely identifies an entity, and is drawn underlined.';
    case 'unique':
      return 'A unique column identifies a row on its own, but it is not the primary key. Another table may point at it instead of at the key.';
    case 'multivalued':
      return 'A multivalued attribute can hold more than one value, and is drawn with a double outline.';
    case 'derived':
      return 'A derived attribute is calculated from other data, and is drawn dashed.';
    case 'composite':
      return 'A composite attribute is made of smaller parts.';
    default:
      return 'A simple attribute holds one value.';
  }
}
