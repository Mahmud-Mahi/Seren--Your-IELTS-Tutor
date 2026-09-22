import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { applyTextScale, applyUiZoom } from './utils/textScale';

// Apply the saved UI zoom and text scale before the first paint so the app never
// flashes at the wrong size.
applyUiZoom();
applyTextScale();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
