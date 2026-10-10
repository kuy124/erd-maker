/**
 * Entry point.
 *
 * The IBM Plex faces are loaded from Google Fonts. Plex was drawn for
 * engineering contexts, which is why it carries this interface, and the mono
 * variant earns its place because cardinality markers, key markers, and
 * generated SQL are all tabular data.
 *
 * `display=swap` means text renders immediately in a fallback and swaps when
 * Plex arrives, so a slow font never blocks the canvas.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('The #root element is missing from index.html.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
