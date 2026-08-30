import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles/tokens.css';
// After tokens.css (whose --sur-* this does not touch) and before theme.css,
// so the role tokens exist for anything theme.css or a view maps onto them.
import './styles/dual-theme.css';
import './styles/theme.css';
import './styles/ide.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);
