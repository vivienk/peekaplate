import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './owner-dashboard.css';

// Development-only page served at /owner-dashboard.html; it is not part of the production build.
// It rebuilds the Owner Dashboard V2 (Simplified) prototype on the light token theme with
// fictional sample data only.
const root = document.getElementById('root');
if (!root) throw new Error('Owner dashboard root element is missing');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
