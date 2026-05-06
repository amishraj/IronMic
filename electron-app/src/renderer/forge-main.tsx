import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import ForgeApp from './components/ForgeApp';
import './styles/globals.css';
import './styles/forge.css';

// Forge entry point. Mounts ONLY the bar UI — no Layout, no router, no
// Timeline / Editor / AI chat / Meeting mode imports. Anything heavy that
// leaks into this bundle defeats Forge's "feel instant" guarantee.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ForgeApp />
  </React.StrictMode>,
);
