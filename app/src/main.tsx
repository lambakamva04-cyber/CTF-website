import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element is missing from index.html');

// The boot skeleton in index.html is markup React does not own. createRoot
// clears the container on its first commit, but removing it explicitly means
// the handover does not depend on that staying true across React versions.
container.replaceChildren();

createRoot(container).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
