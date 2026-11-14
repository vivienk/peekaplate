// Preview-only demo of the S12 first dashboard arrival with fictional setups (PR previews only).
// The live owner API (RES-03) replaces these samples; nothing here is real restaurant data.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@peekaplate/tokens/tokens.css';
import '@peekaplate/ui/components.css';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import './owner.css';
import { FirstDashboard } from './FirstDashboard';
import type { OwnerSetup, StepId } from './setup';

const SAMPLES: Record<string, { label: string; setup: OwnerSetup }> = {
  details: {
    label: 'Details verified, menu not added (Figma)',
    setup: {
      restaurantName: 'Ember & Stone',
      detailsVerified: true,
      menuAdded: false,
      published: false,
    },
  },
  fresh: {
    label: 'Nothing done yet',
    setup: {
      restaurantName: 'Ember & Stone',
      detailsVerified: false,
      menuAdded: false,
      published: false,
    },
  },
  unpublished: {
    label: 'Verified, menu added, not published',
    setup: {
      restaurantName: 'Ember & Stone',
      detailsVerified: true,
      menuAdded: true,
      published: false,
    },
  },
};

const STEP_SCREEN: Record<StepId, string> = {
  details: 'S05 Restaurant details',
  menu: 'S06 Choose how to add your menu',
  publish: 'S10 Review your dishes',
};

function Demo() {
  const [sample, setSample] = useState('details');
  const [note, setNote] = useState('');
  const current = SAMPLES[sample] ?? SAMPLES.details;
  if (!current) return null;
  return (
    <div className="owner-root">
      <div className="owner-demo-bar">
        <span>Synthetic demo · fictional restaurant</span>
        <label>
          Setup state{' '}
          <select value={sample} onChange={(event) => setSample(event.target.value)}>
            {Object.entries(SAMPLES).map(([id, item]) => (
              <option key={id} value={id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <span role="status">{note}</span>
      </div>
      <FirstDashboard
        sample
        setup={current.setup}
        onOpenStep={(step) => setNote(`Would open ${STEP_SCREEN[step]} (not built here)`)}
        onNavigate={(page) =>
          setNote(page === 'setup' ? '' : 'Other dashboard pages are RES-03 (not built here)')
        }
      />
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('First dashboard demo root element is missing');
createRoot(root).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
