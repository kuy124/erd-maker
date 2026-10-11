import { emptyDocument, type ErdDocument } from './types';

export const EXAMPLES = [
  { id: 'orders', name: 'Customer & Order', ratio: '1:N',
    description: 'One customer can place many orders. Each order belongs to one customer.' },
  { id: 'courses', name: 'Student & Course', ratio: 'N:M',
    description: 'Students enroll in several courses, and each course has several students.' },
  { id: 'dependents', name: 'Employee & Dependent', ratio: 'Weak entity',
    description: 'A dependent is identified using its employee and its own name.' },
] as const;

export type ExampleId = typeof EXAMPLES[number]['id'];

export function createExample(id: ExampleId): ErdDocument {
  const example = EXAMPLES.find((item) => item.id === id)!;
  const doc = emptyDocument(example.name + ' — example');
  const names = id === 'orders' ? ['Customer', 'Order'] : id === 'courses' ? ['Student', 'Course'] : ['Employee', 'Dependent'];
  doc.entities = names.map((name, index) => ({
    id: 'example_entity_' + index, name, x: 100 + index * 500, y: 240,
    kind: id === 'dependents' && index === 1 ? 'weak' : 'strong',
  }));
  doc.relationships = [{
    id: 'example_relationship', name: id === 'orders' ? 'places' : id === 'courses' ? 'enrolls in' : 'supports',
    kind: id === 'dependents' ? 'weak' : 'strong', x: 350, y: 234,
  }];
  doc.legs = doc.entities.map((entity, index) => ({
    id: 'example_leg_' + index, fromId: 'example_relationship', toId: entity.id,
    cardinality: id === 'courses' ? (index === 0 ? 'N' : 'M') : index === 0 ? '1' : 'N',
    participation: { min: index === 1 && id !== 'courses' ? 1 : 0, max: index === 0 && id !== 'courses' ? 1 : 'N' },
  }));
  for (const [index, entity] of doc.entities.entries()) {
    const fields = [id === 'dependents' && index === 1 ? 'name' : entity.name.toLowerCase() + '_id',
      id === 'orders' && index === 1 ? 'placed_at' : id === 'courses' && index === 1 ? 'title' :
        id === 'dependents' && index === 1 ? 'birth_date' : 'email'];
    for (const [fieldIndex, name] of fields.entries()) {
      doc.attributes.push({
        id: 'example_attribute_' + index + '_' + fieldIndex, name, x: entity.x - 20 + fieldIndex * 150, y: 100,
        kind: fieldIndex === 0 ? 'key' : 'simple', ownerId: entity.id,
      });
    }
  }
  return doc;
}
