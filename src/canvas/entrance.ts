/**
 * Which connectors were already on the paper when a view opened.
 *
 * Shapes animate on arrival; lines should too, by inking along their own
 * length. That gesture belongs only to lines that arrived, so the renderer
 * needs a stable name for each connector it draws — the same names used as
 * render keys, so a baseline taken once can be compared on every frame.
 *
 * A floating attribute draws no connector, so it gets no id.
 */

import type { ErdDocument } from '../model/types';

export function isaParentEdgeId(isaId: string): string {
  return `isa:${isaId}`;
}

export function isaChildEdgeId(isaId: string, childId: string): string {
  return `isa:${isaId}:${childId}`;
}

export function attributeEdgeId(attributeId: string): string {
  return `attr:${attributeId}`;
}

export function connectorIds(doc: ErdDocument): string[] {
  return [
    ...doc.legs.map((leg) => leg.id),
    ...doc.isas.flatMap((isa) => [
      isaParentEdgeId(isa.id),
      ...isa.childIds.map((childId) => isaChildEdgeId(isa.id, childId)),
    ]),
    ...doc.attributes
      .filter((attribute) => attribute.ownerId !== null)
      .map((attribute) => attributeEdgeId(attribute.id)),
  ];
}
