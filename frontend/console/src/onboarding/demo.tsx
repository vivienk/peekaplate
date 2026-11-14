// Preview-only demo of the owner onboarding screens (FE-05 S05; FE-06 S06–S08), built only for PR
// previews like the sign-in demo. The demo stands in for the caller: it answers saves, link imports,
// uploads and menu processing with the outcomes picked below. Nothing is sent or kept. S08 "Your
// menu is ready to review" is not part of this work (Harshita, with S10): when dishes are found the
// demo only names that screen.
import { StrictMode, useEffect, useId, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../style.css';
import '../auth/demo.css';
import { AddMenuLink, type MenuLinkFailure } from './AddMenuLink';
import { ChooseMenuSource, type MenuSource } from './ChooseMenuSource';
import sampleMenu1 from './demo-assets/sample-menu-1.jpg';
import sampleMenu2 from './demo-assets/sample-menu-2.jpg';
import type { RestaurantDetails as Details } from './details';
import { MenuProcessing, type MenuProcessingState, type MenuSourceItem } from './MenuProcessing';
import { menuFileKind } from './menu-source';
import { OnboardingLayout } from './OnboardingLayout';
import { RestaurantDetails } from './RestaurantDetails';
import { type MenuUpload, UploadMenu } from './UploadMenu';

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

const SCREENS: Record<string, string> = {
  s05: 'S05 Restaurant details',
  s06: 'S06 Choose how to add your menu',
  's07-url': 'S07 Add your menu link',
  's07-upload': 'S07 Upload your menu',
  s08: 'S08 Processing your menu',
};

const PROCESS_ANSWERS: Record<string, string> = {
  dishes: 'Dishes found',
  'no-dishes': 'No dishes found',
  failed: 'Extraction failed',
};

// Shown under "Your source" when S08 is opened from the demo bar.
const SAMPLE_SOURCES: MenuSourceItem[] = [
  { name: 'Ember_Stone_Diner_Menu01.jpeg', kind: 'image', size: 15_000 },
  { name: 'Ember_Stone_Diner_Menu02.jpeg', kind: 'image', size: 15_000 },
];

// Long enough to read the processing screen.
const PROCESS_MS = 2500;

const LINK_ANSWERS: Record<string, string> = {
  accepted: 'Link accepted',
  private: 'Link could not be accessed',
  unsupported: 'Source cannot be imported',
};

const UPLOAD_ANSWERS: Record<string, string> = {
  progress: 'Uploads with progress',
  unknown: 'Uploads without a percentage',
  fail: 'First new file fails',
};

// Upload progress steps.
const TICK_MS = 250;

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
  const [screen, setScreen] = useState('s05');
  const [mode, setMode] = useState<'onboarding' | 'dashboard'>('onboarding');
  const [answer, setAnswer] = useState('saved');
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [run, setRun] = useState(0);
  const [requests, setRequests] = useState(0);
  const [source, setSource] = useState<MenuSource>();
  const [linkAnswer, setLinkAnswer] = useState('accepted');
  const [importing, setImporting] = useState(false);
  const [linkFailure, setLinkFailure] = useState<MenuLinkFailure>();
  const [uploadAnswer, setUploadAnswer] = useState('progress');
  const uploads = useUploads(uploadAnswer, () => setRequests((n) => n + 1));
  const [processAnswer, setProcessAnswer] = useState('failed');
  const [processState, setProcessState] = useState<MenuProcessingState>('processing');
  const [processSources, setProcessSources] = useState<MenuSourceItem[]>(SAMPLE_SOURCES);

  // S08 follows the extraction on its own: processing, then the result picked in the demo bar.
  useEffect(() => {
    if (screen !== 's08' || done) return;
    setProcessState('processing');
    const timer = setTimeout(() => {
      if (processAnswer === 'dishes') {
        setDone('S08 Your menu is ready to review (Harshita, with S10; not part of this demo)');
      } else {
        setProcessState(processAnswer as MenuProcessingState);
      }
    }, PROCESS_MS);
    return () => clearTimeout(timer);
  }, [screen, run, processAnswer, done]);

  const startProcessing = (sources: MenuSourceItem[]) => {
    setProcessSources(sources);
    go('s08');
  };

  const restart = () => {
    setDone(null);
    setFailed(false);
    setSaving(false);
    setImporting(false);
    setLinkFailure(undefined);
    uploads.clear();
    setRun((n) => n + 1);
  };

  const go = (next: string) => {
    setScreen(next);
    restart();
  };

  const importLink = (url: string) => {
    setRequests((n) => n + 1);
    setImporting(true);
    setLinkFailure(undefined);
    setTimeout(() => {
      setImporting(false);
      if (linkAnswer === 'accepted') startProcessing([{ name: url, kind: 'link' }]);
      else setLinkFailure(linkAnswer as MenuLinkFailure);
    }, DELAY_MS);
  };

  const save = () => {
    setRequests((n) => n + 1);
    setSaving(true);
    setFailed(false);
    setTimeout(() => {
      setSaving(false);
      if (answer === 'failed') setFailed(true);
      else if (mode === 'onboarding') setScreen('s06');
      else setDone('S12 Dashboard');
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
            label="Screen"
            options={SCREENS}
            value={screen}
            onChange={(value) => {
              setScreen(value);
              restart();
            }}
          />
          {screen === 's05' && (
            <Choice
              label="S05 opened from"
              options={{
                onboarding: 'Onboarding (first time)',
                dashboard: 'Dashboard (edit saved)',
              }}
              value={mode}
              onChange={(value) => {
                setMode(value as 'onboarding' | 'dashboard');
                restart();
              }}
            />
          )}
          {screen === 's05' && (
            <Choice
              label="Save answer"
              options={{ saved: 'Saved', failed: 'Save failed' }}
              value={answer}
              onChange={setAnswer}
            />
          )}
          {screen === 's07-url' && (
            <Choice
              label="Import answer"
              options={LINK_ANSWERS}
              value={linkAnswer}
              onChange={setLinkAnswer}
            />
          )}
          {screen === 's08' && (
            <Choice
              label="Processing ends with"
              options={PROCESS_ANSWERS}
              value={processAnswer}
              onChange={setProcessAnswer}
            />
          )}
          {screen === 's07-upload' && (
            <>
              <Choice
                label="Upload answer"
                options={UPLOAD_ANSWERS}
                value={uploadAnswer}
                onChange={setUploadAnswer}
              />
              <button type="button" onClick={() => void uploads.addSamples()}>
                Add 2 sample photos
              </button>
            </>
          )}
          <button type="button" onClick={restart}>
            Start again
          </button>
          <p className="pp-auth-demo__count">Requests sent: {requests}</p>
        </div>
      </aside>
      {done ? (
        <div className="pp-auth-demo__done">
          <h1>Next screen (demo)</h1>
          <p>Demo only: nothing was sent or saved. In the product this opens {done}.</p>
          <button type="button" onClick={restart}>
            Start again
          </button>
        </div>
      ) : (
        <OnboardingLayout
          restaurantName={mode === 'dashboard' || screen !== 's05' ? SAMPLE.name : undefined}
          bare={screen === 's07-upload'}
        >
          {screen === 's05' && (
            <RestaurantDetails
              key={`${mode}-${run}`}
              mode={mode}
              saved={mode === 'dashboard' ? SAMPLE : undefined}
              saving={saving}
              saveFailed={failed}
              onSave={save}
              onLeave={() => setDone('S12 Dashboard')}
            />
          )}
          {screen === 's06' && (
            <ChooseMenuSource
              key={run}
              initial={source}
              onContinue={(chosen) => {
                setSource(chosen);
                if (chosen === 'url') go('s07-url');
                else if (chosen === 'upload') go('s07-upload');
                else setDone('S09 Add dish');
              }}
              onBack={() => go('s05')}
            />
          )}
          {screen === 's07-url' && (
            <AddMenuLink
              key={run}
              importing={importing}
              failure={linkFailure}
              onImport={importLink}
              onBack={() => go('s06')}
            />
          )}
          {screen === 's07-upload' && (
            <UploadMenu
              files={uploads.files}
              onAdd={uploads.add}
              onReplace={uploads.replace}
              onRemove={uploads.remove}
              onRetry={uploads.retry}
              onContinue={() =>
                startProcessing(uploads.files.map(({ name, kind, size }) => ({ name, kind, size })))
              }
              onBack={() => go('s06')}
            />
          )}
          {screen === 's08' && (
            <MenuProcessing
              state={processState}
              sources={processSources}
              onCancel={() => setDone('S12 Dashboard')}
              onTryAnother={() => go('s06')}
            />
          )}
        </OnboardingLayout>
      )}
    </>
  );
}

// Stands in for the uploads: each file counts up to 100% and is then uploaded. With "First new file
// fails" the first file of each choice stops at 70%; Retry then succeeds.
function useUploads(answer: string, onRequest: () => void) {
  const [files, setFiles] = useState<MenuUpload[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setInterval>>());
  const urls = useRef(new Map<string, string>());
  const next = useRef(0);

  useEffect(() => {
    const running = timers.current;
    const previews = urls.current;
    return () => {
      for (const timer of running.values()) clearInterval(timer);
      for (const url of previews.values()) URL.revokeObjectURL(url);
    };
  }, []);

  const patch = (id: string, change: Partial<MenuUpload>) =>
    setFiles((current) => current.map((file) => (file.id === id ? { ...file, ...change } : file)));

  const stop = (id: string) => {
    clearInterval(timers.current.get(id));
    timers.current.delete(id);
  };

  const run = (id: string, fail: boolean) => {
    stop(id);
    onRequest();
    const unknown = answer === 'unknown';
    let progress = 0;
    patch(id, { status: 'uploading', progress: unknown ? undefined : 0 });
    timers.current.set(
      id,
      setInterval(() => {
        progress += 10;
        if (fail && progress >= 70) {
          stop(id);
          patch(id, { status: 'failed', progress: 70 });
        } else if (progress >= 100) {
          stop(id);
          patch(id, { status: 'uploaded', progress: 100 });
        } else if (!unknown) {
          patch(id, { progress });
        }
      }, TICK_MS),
    );
  };

  const entry = (file: File, id: string): MenuUpload => {
    const kind = menuFileKind(file) ?? 'image';
    let previewUrl: string | null = null;
    if (kind === 'image') {
      previewUrl = URL.createObjectURL(file);
      urls.current.set(id, previewUrl);
    }
    return { id, name: file.name, size: file.size, kind, status: 'uploading', previewUrl };
  };

  const forget = (id: string) => {
    stop(id);
    const url = urls.current.get(id);
    if (url) URL.revokeObjectURL(url);
    urls.current.delete(id);
  };

  const add = (chosen: File[]) => {
    const added = chosen.map((file) => {
      next.current += 1;
      return entry(file, `file-${next.current}`);
    });
    setFiles((current) => [...current, ...added]);
    added.forEach((file, index) => {
      run(file.id, answer === 'fail' && index === 0);
    });
  };

  const replace = (id: string, file: File) => {
    forget(id);
    const replacement = entry(file, id);
    setFiles((current) => current.map((other) => (other.id === id ? replacement : other)));
    run(id, false);
  };

  const remove = (id: string) => {
    forget(id);
    setFiles((current) => current.filter((file) => file.id !== id));
  };

  const clear = () => {
    for (const id of [...timers.current.keys(), ...urls.current.keys()]) forget(id);
    setFiles([]);
  };

  const addSamples = async () => {
    const samples = await Promise.all(
      [
        [sampleMenu1, 'Ember_Stone_Diner_Menu01.jpeg'],
        [sampleMenu2, 'Ember_Stone_Diner_Menu02.jpeg'],
      ].map(async ([url, name]) => {
        const blob = await (await fetch(url as string)).blob();
        return new File([blob], name as string, { type: 'image/jpeg' });
      }),
    );
    add(samples);
  };

  return { files, add, replace, remove, retry: (id: string) => run(id, false), clear, addSamples };
}

createRoot(root).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
