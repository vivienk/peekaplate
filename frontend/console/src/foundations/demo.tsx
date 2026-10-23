import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../style.css';
import { Input } from './Input';

// Development-only page served at /foundations.html; it is not part of the production build.
const root = document.getElementById('root');
if (!root) throw new Error('Foundations demo root element is missing');

createRoot(root).render(
  <StrictMode>
    <main>
      <p className="eyebrow">PeekaPlate · Design foundations</p>
      <h1>Input foundation</h1>
      <p className="note">
        Synthetic demo: these fields use made-up values and nothing is saved or sent.
      </p>
      <div style={{ display: 'grid', gap: '1.5rem' }}>
        <Input label="Dish name" hint="Shown to diners on the menu." required />
        <Input
          label="Price"
          hint="Numbers only, for example 12.50."
          error="Enter a price"
          inputMode="decimal"
        />
        <Input label="Category" defaultValue="Breakfast" disabled />
        <Input label="Internal note" />
      </div>
    </main>
  </StrictMode>,
);
