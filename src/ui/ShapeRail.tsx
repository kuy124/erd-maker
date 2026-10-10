/**
 * The shape rail.
 *
 * A keyboard-first palette. Every shape has a single-key shortcut, shown on the
 * button, because a diagram tool is used repeatedly and the mouse is the slow
 * path. The rail is also the legend: the glyphs are the notation.
 */

import { ShapeGlyph } from '../canvas/NodeShapes';
import type { EditorState } from '../state/useEditor';

interface Props {
  state: EditorState;
  /** Places a new node near the centre of the visible canvas. */
  onAdd: (kind: 'entity' | 'attribute' | 'relationship' | 'isa') => void;
}

const SHAPES = [
  { kind: 'entity', label: 'Entity', key: 'E', hint: 'A thing you keep records about' },
  { kind: 'attribute', label: 'Attribute', key: 'A', hint: 'A fact about an entity' },
  { kind: 'relationship', label: 'Relationship', key: 'R', hint: 'How two entities are related' },
  { kind: 'isa', label: 'Specialization', key: 'S', hint: 'A subtype of another entity' },
] as const;

export function ShapeRail({ state, onAdd }: Props) {
  return (
    <aside className="rail" aria-label="Shapes" data-testid="rail">
      <div className="rail__group">
        <h2 className="panel__title">Shapes</h2>
        {SHAPES.map((shape) => (
          <button
            key={shape.kind}
            type="button"
            className="shape-btn"
            data-testid={`add-${shape.kind}`}
            onClick={() => onAdd(shape.kind)}
            aria-label={`Add ${shape.label.toLowerCase()}`}
            title={shape.hint}
          >
            <span className="shape-btn__glyph" aria-hidden="true">
              <ShapeGlyph kind={shape.kind} />
            </span>
            <span className="shape-btn__label">{shape.label}</span>
            <span className="shape-btn__key" aria-hidden="true">
              {shape.key}
            </span>
          </button>
        ))}
      </div>

      <div className="rail__group">
        <h2 className="panel__title">Tools</h2>
        <button
          type="button"
          className="shape-btn"
          aria-pressed={state.tool === 'select'}
          aria-label="Select tool"
          onClick={() => state.setTool('select')}
        >
          <span className="shape-btn__glyph" aria-hidden="true">
            <CursorGlyph />
          </span>
          <span className="shape-btn__label">Select</span>
          <span className="shape-btn__key" aria-hidden="true">
            V
          </span>
        </button>
        <button
          type="button"
          className="shape-btn"
          aria-pressed={state.tool === 'pan'}
          aria-label="Pan tool"
          onClick={() => state.setTool('pan')}
        >
          <span className="shape-btn__glyph" aria-hidden="true">
            <HandGlyph />
          </span>
          <span className="shape-btn__label">Pan</span>
          <span className="shape-btn__key" aria-hidden="true">
            H
          </span>
        </button>
      </div>

      <div className="rail__group">
        <h2 className="panel__title">Connect</h2>
        <p className="rail__hint">
          Hold <kbd>Shift</kbd> and click two shapes to draw a relationship between them.
        </p>
      </div>
    </aside>
  );
}

function CursorGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M4 3 L4 16 L7.5 12.5 L10 17 L12 16 L9.5 11.5 L14 11 Z" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function HandGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path
        d="M6 9 V5.5 a1 1 0 0 1 2 0 V9 M8 8.5 V4.5 a1 1 0 0 1 2 0 V9 M10 8.5 V5 a1 1 0 0 1 2 0 V10 M12 10 V7 a1 1 0 0 1 2 0 V12 a4 4 0 0 1 -4 4 h-1.5 a3.5 3.5 0 0 1 -2.6 -1.2 L4 12.4 a1 1 0 0 1 1.6 -1.2 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
