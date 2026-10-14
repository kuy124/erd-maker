import { useEffect, useId, useState } from 'react';
import type { EditorState } from '../state/useEditor';
import type { Cardinality, Participation } from '../model/types';
import type { RelationshipParticipant } from '../collab/participants';
import { validParticipation } from '../model/issues';
import { binaryEnds, deriveTables, endpointRows, type CrowRow } from '../model/crowfoot';

/** Keep unfinished numeric input local. Only a valid pair enters the shared document. */
export function ParticipationFields({ value, onChange }: {
  value: Participation;
  onChange: (value: Participation) => void;
}) {
  const id = useId();
  const [min, setMin] = useState(String(value.min));
  const [max, setMax] = useState(String(value.max));
  useEffect(() => { setMin(String(value.min)); setMax(String(value.max)); }, [value.min, value.max]);
  const parse = (a: string, b: string): Participation | null => {
    if (!/^\d+$/.test(a.trim()) || !/^(\d+|N)$/i.test(b.trim())) return null;
    const next = { min: Number(a), max: b.trim().toUpperCase() === 'N' ? 'N' as const : Number(b) };
    return validParticipation(next.min, next.max) ? next : null;
  };
  const invalid = !parse(min, max);
  const change = (a: string, b: string) => {
    setMin(a); setMax(b);
    const next = parse(a, b);
    if (next) onChange(next);
  };
  return <div className="participation-fields">
    <div className="field__row">
      <div>
        <label className="field__label" htmlFor={id + '-min'}>Minimum</label>
        <input id={id + '-min'} className="field__input" inputMode="numeric" value={min}
          aria-invalid={invalid} aria-describedby={id + '-help'}
          onChange={(event) => change(event.target.value, max)} />
      </div>
      <div>
        <label className="field__label" htmlFor={id + '-max'}>Maximum</label>
        <input id={id + '-max'} className="field__input" value={max} autoCapitalize="characters"
          aria-invalid={invalid} aria-describedby={id + '-help'}
          onChange={(event) => change(min, event.target.value)} />
      </div>
    </div>
    <p id={id + '-help'} className={'field__help' + (invalid ? ' field__help--error' : '')}>
      {invalid ? 'Use whole numbers: minimum 0 or more; maximum at least 1 and no less than minimum, or N. This draft is not shared.' :
        '0 means optional; 1 or more means required. Use N for an unlimited maximum.'}
    </p>
  </div>;
}

export function RelationshipParticipants({ state, relationshipId }: {
  state: EditorState; relationshipId: string;
}) {
  const [drafts, setDrafts] = useState<number[]>([]);
  const [nextDraft, setNextDraft] = useState(0);
  const tables = deriveTables(state.doc);
  const automaticName = (legId: string | undefined) => {
    const doc = { ...state.doc, legs: state.doc.legs.map((leg) => leg.id === legId ? { ...leg, columnId: undefined } : leg) };
    const ends = binaryEnds(doc, relationshipId);
    return ends ? endpointRows(doc, deriveTables(doc), ends)[ends[0].leg.id === legId ? 0 : 1].name : undefined;
  };
  const participants: RelationshipParticipant[] = state.doc.legs.flatMap((leg) => {
    const entityId = leg.fromId === relationshipId ? leg.toId : leg.toId === relationshipId ? leg.fromId : null;
    return entityId && state.doc.entities.some((entity) => entity.id === entityId) ?
      [{ legId: leg.id, entityId, cardinality: leg.cardinality, participation: leg.participation, columnId: leg.columnId }] : [];
  });
  const write = (legId: string | undefined, patch: Partial<RelationshipParticipant>) => {
    state.setParticipants(relationshipId, participants.map((row) => row.legId === legId ? { ...row, ...patch } : row));
  };
  const name = (id: string) => state.doc.entities.find((entity) => entity.id === id)?.name || 'Unnamed entity';
  return <section className="participant-editor" aria-label="Relationship participants">
    <div className="field__heading"><h3>Participants</h3><span>{participants.length}</span></div>
    <p className="field__help">Choose the entities and the attributes joined in table view. Extra participants are kept for relationships involving three or more entities.</p>
    {participants.length === 2 && participants[0]!.entityId === participants[1]!.entityId ?
      <p className="field__help">Unary relationship: the same entity takes two roles. Edit each role’s cardinality and connection attribute independently.</p> : null}
    <div className="ratio-preview" aria-live="polite" data-testid="ratio-preview">
      {participants.length >= 2 ? participants.map((row) => name(row.entityId) + ' (' + row.cardinality + ')').join(' : ') :
        'Add at least two participants to see the ratio.'}
    </div>
    {participants.map((row, index) => <ParticipantRow key={row.legId} state={state} row={row} index={index}
      columns={tables.find((t) => t.entityId === row.entityId)?.rows ?? []}
      automaticName={automaticName(row.legId)}
      onChange={(patch) => write(row.legId, patch)}
      onRemove={() => state.setParticipants(relationshipId, participants.filter((item) => item.legId !== row.legId))} />)}
    {drafts.map((draft, index) => <ParticipantRow key={'draft-' + draft} state={state} index={participants.length + index}
      row={{ entityId: '', cardinality: participants.length === 0 ? '1' : 'N', participation: { min: 0, max: participants.length === 0 ? 1 : 'N' } }}
      onChange={(patch) => {
        if (!patch.entityId) return;
        state.setParticipants(relationshipId, [...participants, {
          entityId: patch.entityId, cardinality: participants.length === 0 ? '1' : 'N',
          participation: { min: 0, max: participants.length === 0 ? 1 : 'N' },
        }]);
        setDrafts((current) => current.filter((value) => value !== draft));
      }} onRemove={() => setDrafts((current) => current.filter((value) => value !== draft))} />)}
    <button type="button" className="btn participant-add" disabled={state.doc.entities.length === 0}
      onClick={() => { setDrafts((current) => [...current, nextDraft]); setNextDraft((current) => current + 1); }}>Add participant</button>
    {state.doc.entities.length === 0 ? <p className="field__help">Add an entity first, then choose it here.</p> : null}
  </section>;
}

function ParticipantRow({ state, row, index, columns = [], automaticName, onChange, onRemove }: {
  state: EditorState; row: RelationshipParticipant; index: number;
  columns?: CrowRow[]; automaticName?: string;
  onChange: (patch: Partial<RelationshipParticipant>) => void; onRemove: () => void;
}) {
  const id = useId();
  const name = state.doc.entities.find((entity) => entity.id === row.entityId)?.name || 'participant ' + (index + 1);
  return <div className="participant-row" data-testid="participant-row">
    <div className="participant-row__header">
      <label className="field__label" htmlFor={id + '-entity'}>Entity {index + 1}</label>
      <button type="button" className="btn btn--ghost btn--icon" aria-label={'Remove ' + name} onClick={onRemove}>×</button>
    </div>
    <select id={id + '-entity'} className="field__select" value={row.entityId}
      onChange={(event) => onChange({ entityId: event.target.value, columnId: null })}>
      <option value="" disabled>Choose an entity</option>
      {state.doc.entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.name || 'Unnamed entity'}</option>)}
    </select>
    {row.entityId ? <>
      <label className="field__label" htmlFor={id + '-column'}>Connection attribute at {name}</label>
      <select id={id + '-column'} className="field__select" value={row.columnId ?? ''}
        onChange={(event) => onChange({ columnId: event.target.value || null })}>
        <option value="">Automatic{automaticName ? ' — ' + automaticName : ''}</option>
        {row.columnId && !columns.some((column) => column.id === row.columnId) ?
          <option value={row.columnId}>Unavailable attribute — choose another</option> : null}
        {columns.map((column) => <option key={column.id} value={column.id}>
          {column.name}{column.pk && column.fk ? ' (PK/FK)' : column.pk ? ' (PK)' : column.fk ? ' (FK)' : ''}
          {column.generatedKey ? ' — generated PK' : column.attributeId ? '' : ' — generated'}
        </option>)}
      </select>
      <label className="field__label" htmlFor={id + '-card'}>Cardinality at {name}</label>
      <select id={id + '-card'} className="field__select" value={row.cardinality}
        onChange={(event) => {
          const cardinality = event.target.value as Cardinality;
          onChange({ cardinality, participation: { min: cardinality === '1' ? Math.min(row.participation.min, 1) : row.participation.min,
            max: cardinality === '1' ? 1 : 'N' } });
        }}>
        <option value="1">1 — one</option><option value="N">N — many</option><option value="M">M — many</option>
      </select>
      <div className="seg participation-choice" role="group" aria-label={'Participation of ' + name}>
        <button type="button" className="seg__btn" aria-pressed={row.participation.min === 0}
          onClick={() => onChange({ participation: { ...row.participation, min: 0 } })}>Optional</button>
        <button type="button" className="seg__btn" aria-pressed={row.participation.min > 0}
          onClick={() => onChange({ participation: { ...row.participation, min: 1 } })}>Required</button>
      </div>
      <details className="advanced-participation"><summary>Minimum / maximum</summary>
        <ParticipationFields value={row.participation} onChange={(participation) => onChange({ participation,
          cardinality: participation.max === 1 ? '1' : row.cardinality === 'M' ? 'M' : 'N' })} />
      </details>
    </> : null}
  </div>;
}
