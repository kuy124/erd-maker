import { legsFor, type ErdDocument } from './types';
import { leafAttributesOf } from './attributes';
import { binaryEnds, deriveTables, endpointRows, foreignKeyDirection } from './crowfoot';

export interface DiagramIssue {
  code: 'unnamed' | 'unattached-attribute' | 'missing-key' | 'incomplete-relationship' | 'invalid-participation' | 'missing-connection-attribute' | 'non-key-reference';
  nodeId: string;
  message: string;
}

/** Modeling hints, not a certificate that a schema is correct. */
export function getDiagramIssues(doc: ErdDocument): DiagramIssue[] {
  const issues: DiagramIssue[] = [];
  const tables = deriveTables(doc);
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
    if (!leafAttributesOf(doc, entity.id).some((a) => a.kind === 'key')) {
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
    const ends = binaryEnds(doc, relationship.id);
    if (ends && ends.some((end) => end.leg.columnId)) {
      const rows = endpointRows(doc, tables, ends);
      const direction = foreignKeyDirection(doc, ends);
      const targets = direction ? [direction[1]] : ends.filter((end) => end.leg.cardinality !== '1');
      const invalidTargets = targets.filter((target) => {
        const row = rows[ends[0].leg.id === target.leg.id ? 0 : 1];
        const keys = tables.find((t) => t.entityId === target.entity.id)!.rows.filter((r) => r.pk);
        return !row.pk || keys.length !== 1;
      });
      if (invalidTargets.length) issues.push({ code: 'non-key-reference', nodeId: relationship.id,
        message: 'For SQL export, connect ' + (relationship.name || 'this relationship') + ' to a single-column primary key at ' +
          invalidTargets.map((end) => end.entity.name || 'this entity').join(' and ') + '.' });
    }
  }
  for (const leg of doc.legs) {
    if (leg.columnId) {
      const relationship = doc.relationships.find((r) => r.id === leg.fromId || r.id === leg.toId);
      const entityId = leg.fromId === relationship?.id ? leg.toId : leg.fromId;
      if (relationship && !tables.find((t) => t.entityId === entityId)?.rows.some((r) => r.id === leg.columnId)) {
        issues.push({ code: 'missing-connection-attribute', nodeId: relationship.id,
          message: (relationship.name || 'This relationship') + ' uses an unavailable attribute. Choose another connection attribute.' });
      }
    }
    const { min, max } = leg.participation;
    if (!validParticipation(min, max)) {
      issues.push({ code: 'invalid-participation', nodeId: leg.id,
        message: 'Use a whole-number minimum of 0 or more, and a maximum at least as large (or N).' });
    }
  }
  return issues.filter((issue, index) => issues.findIndex((other) => other.code === issue.code && other.nodeId === issue.nodeId) === index);
}

export function validParticipation(min: number, max: number | 'N'): boolean {
  return Number.isSafeInteger(min) && min >= 0 &&
    (max === 'N' || (Number.isSafeInteger(max) && max >= 1 && max >= min));
}
