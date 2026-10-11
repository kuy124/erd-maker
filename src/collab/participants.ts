import type { Doc, Map as YMap } from 'yjs';
import type { Cardinality, Participation } from '../model/types';
import { validParticipation } from '../model/issues';
import { snapshotFromYdoc, upsertLeg } from './ydoc';
import { deriveTables } from '../model/crowfoot';

export interface RelationshipParticipant {
  legId?: string;
  entityId: string;
  cardinality: Cardinality;
  participation: Participation;
  /** null clears the selection; omitted retains it when the entity is unchanged. */
  columnId?: string | null;
}

/** Validate everything before touching the shared document; preserve orientation and IDs. */
export function writeParticipants(
  ydoc: Doc, relationshipId: string,
  participants: RelationshipParticipant[], makeId: () => string,
): void {
  if (!ydoc.getMap('relationships').has(relationshipId)) throw new Error('This relationship was removed.');
  const legs = ydoc.getMap<YMap<unknown>>('legs');
  const existing = [...legs.entries()].filter(([, leg]) =>
    leg.get('fromId') === relationshipId || leg.get('toId') === relationshipId);
  const usedIds = new Set<string>();
  const tables = deriveTables(snapshotFromYdoc(ydoc));
  const next = participants.map((participant) => {
    if (!ydoc.getMap('entities').has(participant.entityId)) throw new Error('That entity is no longer available.');
    if (!['1', 'N', 'M'].includes(participant.cardinality) ||
        !validParticipation(participant.participation.min, participant.participation.max)) {
      throw new Error('Correct the cardinality and participation before saving.');
    }
    const id = participant.legId ?? makeId();
    if (usedIds.has(id)) throw new Error('A participant line was repeated.');
    usedIds.add(id);
    const old = legs.get(id);
    if (old && !existing.some(([oldId]) => oldId === id)) throw new Error('That line belongs to another relationship.');
    const oldEntity = old?.get('fromId') === relationshipId ? old.get('toId') : old?.get('fromId');
    const columnId = participant.columnId === undefined && oldEntity === participant.entityId ? old?.get('columnId') : participant.columnId;
    // An unchanged missing column remains a visible finding, so other properties can still be edited.
    if (columnId && (columnId !== old?.get('columnId') || oldEntity !== participant.entityId) &&
        !tables.find((t) => t.entityId === participant.entityId)?.rows.some((r) => r.id === columnId)) {
      throw new Error('That attribute is no longer available. Choose another connection attribute.');
    }
    return {
      id, fromId: old?.get('toId') === relationshipId ? participant.entityId : relationshipId,
      toId: old?.get('toId') === relationshipId ? relationshipId : participant.entityId,
      cardinality: participant.cardinality, participation: participant.participation,
      ...(typeof columnId === 'string' && columnId ? { columnId } : {}),
    };
  });
  ydoc.transact(() => {
    for (const [id, leg] of existing) {
      const other = leg.get('fromId') === relationshipId ? leg.get('toId') : leg.get('fromId');
      // Non-entity legs can describe other concepts and are not edited by this form.
      if (ydoc.getMap('entities').has(String(other)) && !usedIds.has(id)) legs.delete(id);
    }
    for (const leg of next) upsertLeg(ydoc, leg);
  });
}
