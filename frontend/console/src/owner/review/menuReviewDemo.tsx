// Preview-only demo of S10 "Menu Review" (S5-FE-10) with fictional dishes (PR previews only). The
// dishes are the owner dashboard's own menu data, and Add dish / Edit open the dashboard's Screen 9
// form, so S10, that form and the Menu screen all work on the same dishes. The owner draft API
// replaces these stand-ins; nothing here is real restaurant data. The navigation is the confirmed
// onboarding flow:
//   Cancel -> Screen 8 (its S08 "Ready to review" frame is a separate task, so a note stands in)
//   Add dish / Edit -> Screen 9; Back or Continue to review returns to S10
//   Save and Exit -> first-time dashboard (menu step still open)
//   Complete verification -> "Menu verified" pop-up -> Go to dashboard (step 3 next)
// Nothing is published or linked from here: publishing happens in the dashboard's "Review and
// publish" step, and only a real publish request may show a published state or a link.
import { StrictMode, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@peekaplate/tokens/tokens.css';
import '@peekaplate/ui/components.css';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '../../owner-dashboard/owner-dashboard.css';
import '../owner.css';
import './review.css';
import { imgOf, initialMenu, type MenuItem, newDraft } from '../../owner-dashboard/data';
import { DishForm, type EditState } from '../../owner-dashboard/menu';
import { FirstDashboard } from '../FirstDashboard';
import type { OwnerSetup, StepId } from '../setup';
import { menuItemToReviewDish } from './fromMenuItem';
import { ReviewDishes } from './MenuReview';
import {
  addDish,
  initialReview,
  type ReviewDish,
  type ReviewState,
  removeDish,
  saveEdit,
  undoRemove,
} from './reviewDishes';

const RESTAURANT = 'Ember & Stone';

// S12 after Save and Exit: details verified, the menu step still open so the owner can come back.
const SAVED_AND_EXITED: OwnerSetup = {
  venueId: 'demo-venue',
  restaurantName: RESTAURANT,
  detailsStatus: 'verified',
  menuAdded: false,
  published: false,
};

// S12 right after verification: step 2 done, step 3 "Review and publish" next. Synthetic; nothing is
// published and no link exists.
const AFTER_VERIFICATION: OwnerSetup = { ...SAVED_AND_EXITED, menuAdded: true };

// Illustrative allergens for the sample dishes, so most rows show them as recorded (as in Figma).
const ALLERGENS: Record<string, string[]> = {
  avotoast: ['egg', 'wheat'],
  benedict: ['egg', 'milk', 'wheat'],
  harvest: ['milk'],
  poke: ['fish', 'soy', 'sesame'],
  greek: ['milk'],
};
// Demo: the owner has confirmed that these two dishes contain none of the listed allergens.
const CONFIRMED_NONE: ReadonlySet<string> = new Set(['berrypancakes', 'frenchtoast']);

// A dashboard dish as S10 shows it. Everything comes from the dish itself; nothing is invented.
const toReviewDish = (item: MenuItem): ReviewDish =>
  menuItemToReviewDish({
    id: item.id,
    name: item.name,
    cat: item.cat,
    desc: item.desc,
    price: item.price,
    ing: item.ing,
    aiIng: item.aiIng,
    aiReviewed: item.aiReviewed,
    alg: item.alg,
    aiAlg: item.aiAlg,
    servingSize: item.size,
    photoId: imgOf(item) ? (item.id ?? 'uploaded-photo') : null,
    allergensConfirmed: item.id !== null && CONFIRMED_NONE.has(item.id),
  });

// The Figma example: the dashboard's seven dishes, one without a price, one without a category and
// one without a serving size ("ready" fills all three in).
function sampleItems(kind: 'fixes' | 'ready'): MenuItem[] {
  return initialMenu().map((item) => {
    const dish: MenuItem = { ...item, alg: ALLERGENS[item.id ?? ''] ?? [], size: '1 serving' };
    if (kind === 'ready') return dish;
    if (item.id === 'berrypancakes') return { ...dish, price: '' };
    if (item.id === 'frenchtoast') return { ...dish, cat: '' };
    if (item.id === 'benedict') return { ...dish, size: '' };
    return dish;
  });
}

const SAMPLES: Record<string, { label: string; items: MenuItem[]; fails?: boolean }> = {
  fixes: { label: 'Three dishes need fixes (Figma)', items: sampleItems('fixes') },
  ready: { label: 'Every dish is Ready (Figma)', items: sampleItems('ready') },
  fails: {
    label: 'Every dish is Ready, completing fails',
    items: sampleItems('ready'),
    fails: true,
  },
  empty: { label: 'No dishes', items: [] },
};

type View = 'review' | 'form' | 'saved' | 'verified';
type Editing = { ed: Extract<EditState, { step: 'form' | 'review' }>; orig: MenuItem | null };

function startState(id: string): { items: MenuItem[]; state: ReviewState } {
  const items = SAMPLES[id]?.items ?? [];
  return { items, state: initialReview(items.map(toReviewDish)) };
}

function Demo() {
  const [sample, setSample] = useState('fixes');
  const [items, setItems] = useState<MenuItem[]>(() => startState('fixes').items);
  const [state, setState] = useState<ReviewState>(() => startState('fixes').state);
  const [view, setView] = useState<View>('review');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [note, setNote] = useState('');
  const added = useRef(0);
  const current = SAMPLES[sample] ?? SAMPLES.fixes;

  const reset = (id: string) => {
    const next = startState(id);
    setSample(id);
    setItems(next.items);
    setState(next.state);
    setView('review');
    setEditing(null);
    setCompleteError(null);
    setVerified(false);
    setNote('');
  };

  // Screen 9: Add dish opens it empty, Edit opens that dish. Back and Continue return to S10.
  const onAddDish = () => {
    setEditing({ ed: { step: 'form', draft: newDraft(), origId: null }, orig: null });
    setView('form');
    setNote('');
  };

  const onEditDish = (id: string) => {
    const item = items.find((entry) => entry.id === id);
    if (!item) return;
    setEditing({ ed: { step: 'form', draft: { ...item }, origId: id }, orig: item });
    setView('form');
    setNote('');
  };

  const onContinue = () => {
    if (!editing) return;
    const draft = editing.ed.draft;
    const isNew = editing.orig === null;
    if (isNew) added.current += 1;
    const saved: MenuItem = { ...draft, id: draft.id ?? `new-${added.current}` };
    if (isNew) {
      setItems([...items, saved]);
      setState(addDish(state, toReviewDish(saved)));
    } else {
      setItems(items.map((entry) => (entry.id === saved.id ? saved : entry)));
      setState(saveEdit(state, toReviewDish(saved)));
    }
    setEditing(null);
    setView('review');
  };

  const onBackToReview = () => {
    setEditing(null);
    setView('review');
  };

  const onCompleteVerification = () => {
    if (current?.fails) {
      // Interim wording for the demo only; real copy is not in Figma yet.
      setCompleteError('We could not complete verification. Please try again.');
      return;
    }
    setCompleteError(null);
    // Shows the "Menu verified" pop-up. Nothing is published.
    setVerified(true);
  };

  const onGoToDashboard = () => {
    setVerified(false);
    setView('verified');
    setNote('Demo only: this is S12 after verification. Nothing was published.');
  };

  const onOpenStep = (step: StepId) => {
    if (step === 'menu') {
      setView('review');
      setNote('');
      return;
    }
    setNote(
      step === 'publish'
        ? 'Demo only: Review and publish is the next screen (S13), not built here.'
        : 'Demo only: would open that step.',
    );
  };

  return (
    <div className="owner-root">
      <aside className="owner-demo-bar" aria-label="Demo controls">
        <span>Synthetic demo · Illustrative sample data · fictional restaurant</span>
        <label>
          Menu state{' '}
          <select value={sample} onChange={(event) => reset(event.target.value)}>
            {Object.entries(SAMPLES).map(([id, item]) => (
              <option key={id} value={id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        {(view === 'saved' || view === 'verified') && (
          <button type="button" onClick={() => setView('review')}>
            Back to menu review (demo)
          </button>
        )}
        <span role="status">{note}</span>
      </aside>
      {view === 'form' && editing && (
        <main
          className="review-card review-form-view"
          style={{ marginBlock: 'var(--pp-space-32)' }}
        >
          <DishForm
            ed={editing.ed}
            setEd={(next) => {
              if (next.step === 'form' || next.step === 'review') {
                setEditing({ ...editing, ed: next });
              }
            }}
            orig={editing.orig}
            cancel={onBackToReview}
            toReview={onContinue}
            requireReviewBox
          />
        </main>
      )}
      {(view === 'saved' || view === 'verified') && (
        <FirstDashboard
          setup={view === 'saved' ? SAVED_AND_EXITED : AFTER_VERIFICATION}
          onOpenStep={onOpenStep}
          onNavigate={() => setNote('Demo only: would open that page.')}
        />
      )}
      {view === 'review' && (
        <ReviewDishes
          restaurantName={RESTAURANT}
          state={state}
          completeError={completeError}
          onAddDish={onAddDish}
          onEditDish={onEditDish}
          onRemoveDish={(id) => setState(removeDish(state, id))}
          onUndoRemove={() => setState(undoRemove(state))}
          onCancel={() =>
            setNote(
              'Demo only: goes back to Screen 8 (Ready to review), which is a separate screen.',
            )
          }
          onSaveAndExit={() => {
            setView('saved');
            setNote('Demo only: progress saved; this is the first-time dashboard.');
          }}
          onCompleteVerification={onCompleteVerification}
          verified={verified}
          onGoToDashboard={onGoToDashboard}
        />
      )}
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Menu review demo root element is missing');
document.body.classList.add('owner-dashboard-demo');
createRoot(root).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
