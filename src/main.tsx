import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { applyTextScale, applyUiZoom } from './utils/textScale';
import { installSyncInterceptor } from './auth/sync';

// Apply the saved UI zoom and text scale before the first paint so the app never
// flashes at the wrong size.
applyUiZoom();
applyTextScale();

// Start tracking every `seren_*` localStorage write immediately — once signed
// in, they upload to the account automatically (debounced, converged merge).
installSyncInterceptor();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
