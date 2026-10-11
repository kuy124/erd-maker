import { ShapeGlyph } from '../canvas/NodeShapes';
import type { EditorState } from '../state/useEditor';

export type ShapeKind = 'entity' | 'attribute' | 'relationship' | 'isa';

const SHAPES = [
  { kind: 'entity', label: 'Entity', key: 'E', hint: 'A thing you keep records about' },
  { kind: 'attribute', label: 'Attribute', key: 'A', hint: 'A fact about the selected entity' },
  { kind: 'relationship', label: 'Relationship', key: 'R', hint: 'How entities relate to each other' },
  { kind: 'isa', label: 'Specialization', key: 'S', hint: 'A superclass and its subtypes' },
] as const;

export function ShapeRail({ state, onAdd, onExamples }: {
  state: EditorState; onAdd: (kind: ShapeKind) => void; onExamples: () => void;
}) {
  return (
    <aside className="rail" aria-label="Shapes" data-testid="rail">
      <h2 className="panel__title">{state.view === 'chen' ? 'Add a shape' : 'Build the model'}</h2>
      {SHAPES.map((shape) => (
        <button key={shape.kind} type="button" className="shape-btn" data-testid={'add-' + shape.kind}
          onClick={() => onAdd(shape.kind)} disabled={!state.loaded}
          aria-label={'Add ' + shape.label.toLowerCase()} title={shape.hint}>
          <span className="shape-btn__glyph" aria-hidden="true"><ShapeGlyph kind={shape.kind} /></span>
          <span className="shape-btn__label">{shape.label}</span>
          <kbd className="shape-btn__key">{shape.key}</kbd>
        </button>
      ))}
      <p className="rail__hint">Select an entity before adding an attribute to attach it automatically.</p>
      <div className="rail__group rail__lesson">
        <h3 className="panel__title">Make a relationship</h3>
        <p className="rail__hint">Add a relationship and choose its participants in Properties.
          {state.view === 'chen' ? ' You can also use Connect to drag between shapes, or Shift-click two shapes.' : ' Specialization opens in Chen.'}</p>
      </div>
      <button type="button" className="btn" onClick={onExamples}>Open an example</button>
      <p className="rail__hint">Try one-to-many, many-to-many, or a weak entity.</p>
    </aside>
  );
}
