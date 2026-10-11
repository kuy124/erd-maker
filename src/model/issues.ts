import { attributesOf, legsFor, type ErdDocument } from './types';

export interface DiagramIssue {
  code: 'unnamed' | 'unattached-attribute' | 'missing-key' | 'incomplete-relationship' | 'invalid-participation';
  nodeId: string;
  message: string;
}

/** Modeling hints, not a certificate that a schema is correct. */
export function getDiagramIssues(doc: ErdDocument): DiagramIssue[] {
  const issues: DiagramIssue[] = [];
  for (const node of [...doc.entities, ...doc.attributes, ...doc.relationships]) {
    if (!node.name.trim()) issues.push({ code: 'unnamed', nodeId: node.id, message: 'Give this shape a name.' });
  }
  for (const attribute of doc.attributes) {
    if (!attribute.ownerId) {
      issues.push({ code: 'unattached-attribute', nodeId: attribute.id,
        message: (attribute.name || 'This attribute') + ' needs an owner.' });
    }
  }
  for (const entity of doc.entities) {
    if (!attributesOf(doc, entity.id).some((a) => a.kind === 'key')) {
      issues.push({ code: 'missing-key', nodeId: entity.id,
        message: 'Choose a key for ' + (entity.name || 'this entity') + ' to identify each record.' });
    }
  }
  for (const relationship of doc.relationships) {
    const participants = legsFor(doc, relationship.id).filter((leg) => {
      const other = leg.fromId === relationship.id ? leg.toId : leg.fromId;
      return doc.entities.some((entity) => entity.id === other);
    });
    if (participants.length < 2) {
      issues.push({ code: 'incomplete-relationship', nodeId: relationship.id,
        message: 'Connect ' + (relationship.name || 'this relationship') + ' to at least two entities.' });
    }
  }
  for (const leg of doc.legs) {
    const { min, max } = leg.participation;
    if (!validParticipation(min, max)) {
      issues.push({ code: 'invalid-participation', nodeId: leg.id,
        message: 'Use a whole-number minimum of 0 or more, and a maximum at least as large (or N).' });
    }
  }
  return issues;
}

export function validParticipation(min: number, max: number | 'N'): boolean {
  return Number.isSafeInteger(min) && min >= 0 &&
    (max === 'N' || (Number.isSafeInteger(max) && max >= 1 && max >= min));
}
