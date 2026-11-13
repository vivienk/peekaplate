// Preview-only demo of the owner onboarding screens (FE-05 S05; FE-06 S06–S08 follow), built only
// for PR previews like the sign-in demo. The demo stands in for the caller: it answers saves with
// the outcome picked below. Nothing is sent or kept.
import { StrictMode, useId, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../style.css';
import '../auth/demo.css';
import type { RestaurantDetails as Details } from './details';
import { OnboardingLayout } from './OnboardingLayout';
import { RestaurantDetails } from './RestaurantDetails';

const root = document.getElementById('root');
if (!root) throw new Error('Owner onboarding demo root element is missing');

// Fictional saved details for the dashboard state.
const SAMPLE: Details = {
  name: 'Ember & Stone',
  city: 'San Francisco',
  street: '742 Evergreen Terrace',
  line2: '',
  phone: '(555) 234-5678',
  email: 'owner@emberandstone.com',
};

// Long enough to see the saving state.
const DELAY_MS = 900;

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
  const [mode, setMode] = useState<'onboarding' | 'dashboard'>('onboarding');
  const [answer, setAnswer] = useState('saved');
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [run, setRun] = useState(0);
  const [requests, setRequests] = useState(0);

  const restart = () => {
    setDone(null);
    setFailed(false);
    setSaving(false);
    setRun((n) => n + 1);
  };

  const save = () => {
    setRequests((n) => n + 1);
    setSaving(true);
    setFailed(false);
    setTimeout(() => {
      setSaving(false);
      if (answer === 'failed') setFailed(true);
      else setDone(mode === 'onboarding' ? 'S06 Choose how to add your menu' : 'S12 Dashboard');
    }, DELAY_MS);
  };

  return (
    <>
      <aside className="pp-auth-demo" aria-label="Demo controls">
        <p className="pp-auth-demo__label">
          <strong>Synthetic demo.</strong> Fictional restaurant: nothing you type is sent or kept.
          Pick the screen's state and what the save answers.
        </p>
        <div className="pp-auth-demo__choices">
          <Choice
            label="S05 opened from"
            options={{ onboarding: 'Onboarding (first time)', dashboard: 'Dashboard (edit saved)' }}
            value={mode}
            onChange={(value) => {
              setMode(value as 'onboarding' | 'dashboard');
              restart();
            }}
          />
          <Choice
            label="Save answer"
            options={{ saved: 'Saved', failed: 'Save failed' }}
            value={answer}
            onChange={setAnswer}
          />
          <button type="button" onClick={restart}>
            Start again
          </button>
          <p className="pp-auth-demo__count">Requests sent: {requests}</p>
        </div>
      </aside>
      {done ? (
        <div className="pp-auth-demo__done">
          <h1>Saved (demo)</h1>
          <p>Demo only: nothing was saved. In the product this opens {done}.</p>
          <button type="button" onClick={restart}>
            Start again
          </button>
        </div>
      ) : (
        <OnboardingLayout restaurantName={mode === 'dashboard' ? SAMPLE.name : undefined}>
          <RestaurantDetails
            key={`${mode}-${run}`}
            mode={mode}
            saved={mode === 'dashboard' ? SAMPLE : undefined}
            saving={saving}
            saveFailed={failed}
            onSave={save}
            onLeave={() => setDone('S12 Dashboard')}
          />
        </OnboardingLayout>
      )}
    </>
  );
}

createRoot(root).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
