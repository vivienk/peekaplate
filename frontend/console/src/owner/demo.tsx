// Preview-only demo of the owner onboarding (S12 first dashboard arrival, S6-FE-14) with fictional
// setups (PR previews only). The live owner API replaces these samples; nothing here is real
// restaurant data, and "publishing" here only flips a local flag to show the success pop-up.
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

const DEMO_VENUE = 'demo-venue-ember-and-stone';

const SAMPLES: Record<string, { label: string; setup: OwnerSetup }> = {
  details: {
    label: 'Details verified, menu not added (Figma)',
    setup: {
      venueId: DEMO_VENUE,
      restaurantName: 'Ember & Stone',
      detailsStatus: 'verified',
      menuAdded: false,
      published: false,
    },
  },
  fresh: {
    label: 'Nothing done yet',
    setup: {
      venueId: DEMO_VENUE,
      restaurantName: 'Ember & Stone',
      detailsStatus: 'missing',
      menuAdded: false,
      published: false,
    },
  },
  submitted: {
    label: 'Details sent, waiting for verification',
    setup: {
      venueId: DEMO_VENUE,
      restaurantName: 'Ember & Stone',
      detailsStatus: 'submitted',
      menuAdded: true,
      published: false,
    },
  },
  unpublished: {
    label: 'Verified, menu added, not published',
    setup: {
      venueId: DEMO_VENUE,
      restaurantName: 'Ember & Stone',
      detailsStatus: 'verified',
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
  const [published, setPublished] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [note, setNote] = useState('');
  const base = SAMPLES[sample] ?? SAMPLES.details;
  if (!base) return null;
  const setup: OwnerSetup = { ...base.setup, published: base.setup.published || published };
  return (
    <div className="owner-root">
      <div className="owner-demo-bar">
        <span>Synthetic demo · Illustrative sample data · fictional restaurant</span>
        <label>
          Setup state{' '}
          <select
            value={sample}
            onChange={(event) => {
              setSample(event.target.value);
              setPublished(false);
              setShowSuccess(false);
              setNote('');
            }}
          >
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
        setup={setup}
        showPublishSuccess={showSuccess}
        onClosePublishSuccess={() => {
          setShowSuccess(false);
          setNote('Back on the dashboard. The other pages are now open (RES-03 builds them).');
        }}
        onOpenStep={(step) => {
          if (step === 'publish' && !setup.published) {
            // Demo only: pretend S10 ran and the API confirmed publication.
            setPublished(true);
            setShowSuccess(true);
            setNote('Demo: publication confirmed (no real API call).');
            return;
          }
          setNote(`Would open ${STEP_SCREEN[step]} (not built here)`);
        }}
        onNavigate={(page) =>
          setNote(page === 'setup' ? '' : `Would open the ${page} page (RES-03, not built here)`)
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
