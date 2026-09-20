import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { migrateLegacyLumiData } from './utils/legacyDataMigration';

// Carry any pre-rename `lumi_*` localStorage data over to the `seren_*` keys
// (copy-only — legacy keys are never deleted) before the app first reads them.
migrateLegacyLumiData();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
