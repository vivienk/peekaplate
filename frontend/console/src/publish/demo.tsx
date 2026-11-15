// Preview-only demo of S13 (menu preview and publish), built only for PR previews like the other
// owner demos. The demo stands in for the caller: it answers the publish request with the outcome
// picked below. Nothing is sent or published. The phone shows the diner preview of the same build.
import { StrictMode, useId, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../style.css';
import '../auth/demo.css';
import { dinerPreviewUrl } from './diner-url';
import { MenuPreview } from './MenuPreview';

const root = document.getElementById('root');
if (!root) throw new Error('Menu preview demo root element is missing');

// Fictional restaurant; the URL stands in for the one the publish API returns.
const RESTAURANT = 'Ember & Stone';
const SAMPLE_URL = 'https://peekaplate.app/diner/ember-stone';
const DELAY_MS = 900;

const MENU_STATES = {
  ready: 'Ready to publish',
  'not-ready': 'Not ready (2 dishes missing details)',
};
const OUTCOMES = { success: 'Publish succeeds', failure: 'Publish fails' };

function Choice({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Record<string, string>;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="pp-auth-demo__choice">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        {Object.entries(options).map(([key, text]) => (
          <option key={key} value={key}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );
}

function Demo() {
  const [menu, setMenu] = useState<keyof typeof MENU_STATES>('ready');
  const [outcome, setOutcome] = useState<keyof typeof OUTCOMES>('success');
  const [publishing, setPublishing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null);
  const [requests, setRequests] = useState(0);
  const [done, setDone] = useState<string | null>(null);
  const [run, setRun] = useState(0);

  const restart = () => {
    setPublishing(false);
    setFailed(false);
    setPublishedUrl(null);
    setDone(null);
    setRun((n) => n + 1);
  };

  const publish = () => {
    setRequests((n) => n + 1);
    setPublishing(true);
    setFailed(false);
    window.setTimeout(() => {
      setPublishing(false);
      if (outcome === 'success') setPublishedUrl(SAMPLE_URL);
      else setFailed(true);
    }, DELAY_MS);
  };

  return (
    <>
      <aside className="pp-auth-demo" aria-label="Demo controls">
        <p className="pp-auth-demo__label">
          <strong>Synthetic demo.</strong> Fictional restaurant: nothing is sent or published. The
          phone shows this build's diner preview; the published link is an example.
        </p>
        <div className="pp-auth-demo__choices">
          <Choice
            label="Menu"
            options={MENU_STATES}
            value={menu}
            onChange={(value) => {
              setMenu(value as keyof typeof MENU_STATES);
              restart();
            }}
          />
          <Choice
            label="Publish answer"
            options={OUTCOMES}
            value={outcome}
            onChange={(value) => setOutcome(value as keyof typeof OUTCOMES)}
          />
          <button type="button" onClick={restart}>
            Start again
          </button>
          <p className="pp-auth-demo__count">Requests sent: {requests}</p>
        </div>
      </aside>
      {done ? (
        <div className="pp-auth-demo__done">
          <h1>Next screen (demo)</h1>
          <p>Demo only: nothing was sent or published. In the product this opens {done}.</p>
          <button type="button" onClick={restart}>
            Start again
          </button>
        </div>
      ) : (
        <MenuPreview
          key={run}
          restaurantName={RESTAURANT}
          dishCount={7}
          categoryCount={3}
          dinerUrl={dinerPreviewUrl(window.location)}
          dishesMissingDetails={menu === 'not-ready' ? 2 : 0}
          publishing={publishing}
          publishFailed={failed}
          publishedUrl={publishedUrl}
          onBackToEdit={() => setDone('menu editing (S10 or S12, TBD in the handoff)')}
          onReviewDishes={() => setDone('S10 Review dishes')}
          onPublish={publish}
          onGoToDashboard={() => setDone('the S12 dashboard')}
        />
      )}
    </>
  );
}

createRoot(root).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
