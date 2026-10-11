/**
 * Last line of defence against a white screen.
 *
 * React unmounts the entire tree when a render throws. Without a boundary that
 * is a blank page with nothing to report and nothing to click, even though the
 * editor was reachable a moment earlier and the diagram is still saved in
 * IndexedDB.
 *
 * Reload is offered because it genuinely recovers: the room lives in the URL
 * hash and the document is persisted, so nothing is lost by reloading.
 *
 * Boundaries are a class component because React has no hook equivalent of
 * `getDerivedStateFromError`.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  message: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('The editor could not be displayed.', error, info.componentStack);
  }

  render() {
    if (this.state.message === null) return this.props.children;
    return (
      <main className="loading-editor">
        <h1>ERD Maker</h1>
        <p role="alert">This diagram hit a problem and stopped drawing. Your work is saved in this browser.</p>
        <p className="note note--warn">{this.state.message}</p>
        <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
          Reload the editor
        </button>
      </main>
    );
  }
}
