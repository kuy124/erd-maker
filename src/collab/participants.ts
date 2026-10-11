import type { Doc, Map as YMap } from 'yjs';
import type { Cardinality, Participation } from '../model/types';
import { validParticipation } from '../model/issues';
import { upsertLeg } from './ydoc';

export interface RelationshipParticipant {
  legId?: string;
  entityId: string;
  cardinality: Cardinality;
  participation: Participation;
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
    return {
      id, fromId: old?.get('toId') === relationshipId ? participant.entityId : relationshipId,
      toId: old?.get('toId') === relationshipId ? relationshipId : participant.entityId,
      cardinality: participant.cardinality, participation: participant.participation,
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
