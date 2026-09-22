import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { applyTextScale } from './utils/textScale';

// Apply the saved text/UI zoom before the first paint so the app never
// flashes at the wrong size.
applyTextScale();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
