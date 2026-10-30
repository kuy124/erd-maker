import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { readIntent } from '../../src/collab/presence';
import { readPeers } from '../../src/collab/provider';

describe('intent reading', () => {
  it('reads the gesture the AI is performing at a shape', () => {
    expect(readIntent({ kind: 'press', targetId: 'ent_customer' }))
      .toEqual({ kind: 'press', targetId: 'ent_customer' });
    expect(readIntent({ kind: 'think' })).toEqual({ kind: 'think' });
  });

  it('ignores an unknown gesture, a non-object, and a missing kind', () => {
    expect(readIntent(undefined)).toBeNull();
    expect(readIntent(null)).toBeNull();
    expect(readIntent('press')).toBeNull();
    expect(readIntent({ kind: 'teleport' })).toBeNull();
    expect(readIntent({ targetId: 'ent_customer' })).toBeNull();
  });

  it('keeps a lasso trail of finite points and caps a hostile one', () => {
    expect(readIntent({
      kind: 'lasso',
      lasso: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 'no', y: 4 }, null],
    })).toEqual({ kind: 'lasso', lasso: [{ x: 1, y: 2 }, { x: 3, y: 4 }] });

    const flood = Array.from({ length: 500 }, (_, index) => ({ x: index, y: index }));
    const capped = readIntent({ kind: 'lasso', lasso: flood });
    expect(capped?.lasso?.length).toBeLessThanOrEqual(128);
  });
});

describe('peer intent', () => {
  it('surfaces an intent published by a peer, and nothing for a peer that never sends one', () => {
    const awareness = new Awareness(new Y.Doc());
    awareness.setLocalState({
      name: 'AI assistant',
      color: '#6B3FA0',
      cursor: { x: 1, y: 2 },
      selectedIds: [],
      view: 'chen',
      pressing: true,
      typing: false,
      intent: { kind: 'press', targetId: 'ent_customer' },
    });
    expect(readPeers(awareness, -1)[0]?.intent).toEqual({ kind: 'press', targetId: 'ent_customer' });

    awareness.setLocalState({ name: 'Peer' });
    expect(readPeers(awareness, -1)[0]?.intent).toBeNull();
    awareness.destroy();
  });
});
