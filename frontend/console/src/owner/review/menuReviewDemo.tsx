// Preview-only demo of S10 "Menu Review" (S5-FE-10) with fictional dishes (PR previews only). The
// dishes come from the owner dashboard's menu data (the data behind its Menu screen), so S10 and
// that screen show the same menu. The owner draft API, the S09 form and the real navigation replace
// these stand-ins; nothing here is real restaurant data. The buttons only describe where the real
// flow goes. Nothing is published or linked from here: publishing happens in the dashboard's
// "Review and publish" step, and only a real publish request may show a published state or a link.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@peekaplate/tokens/tokens.css';
import '@peekaplate/ui/components.css';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '../owner.css';
import './review.css';
import { DISH, initialMenu, THUMBS } from '../../owner-dashboard/data';
import { FirstDashboard } from '../FirstDashboard';
import type { OwnerSetup } from '../setup';
import { type DashboardMenuItem, menuItemToReviewDish } from './fromMenuItem';
import { ReviewDishes } from './MenuReview';
import {
  initialReview,
  type ReviewDish,
  type ReviewState,
  removeDish,
  undoRemove,
} from './reviewDishes';

const RESTAURANT = 'Ember & Stone';

// What S12 shows right after verification: step 2 done, step 3 "Review and publish" next. Synthetic;
// nothing is published and no link exists.
const AFTER_VERIFICATION: OwnerSetup = {
  venueId: 'demo-venue',
  restaurantName: RESTAURANT,
  detailsStatus: 'verified',
  menuAdded: true,
  published: false,
};

// Illustrative allergens for the sample dishes, so most rows show them as recorded (as in Figma).
// Berry Pancake Stack and Brioche French Toast have none recorded.
const ALLERGENS: Record<string, string[]> = {
  avotoast: ['egg', 'wheat'],
  benedict: ['egg', 'milk', 'wheat'],
  harvest: ['milk'],
  poke: ['fish', 'soy', 'sesame'],
  greek: ['milk'],
};

const dashboardDishes = (): DashboardMenuItem[] =>
  initialMenu().map((item) => ({
    ...item,
    alg: ALLERGENS[item.id ?? ''] ?? [],
    // Demo: the owner has confirmed the allergens of every sample dish (some have none).
    allergensConfirmed: true,
    // Description and photo come from the same dashboard sample data (nothing is invented here).
    desc: DISH.find((dish) => dish.id === item.id)?.desc ?? '',
    photoId: item.id !== null && THUMBS[item.id] ? item.id : null,
    // Figma S10 shows Classic Eggs Benedict as "Serving Size Missing"; the others have one.
    servingSize: item.id === 'benedict' ? null : '1 serving',
  }));

// The Figma example: the dashboard's seven dishes, one without a price and one without a category.
const NEEDS_FIXES: ReviewDish[] = dashboardDishes().map((item) => {
  if (item.id === 'berrypancakes') return menuItemToReviewDish({ ...item, price: '' });
  if (item.id === 'frenchtoast') return menuItemToReviewDish({ ...item, cat: '' });
  return menuItemToReviewDish(item);
});

// The same menu after the missing price and category are filled in (Figma "Ready to publish").
const ALL_READY: ReviewDish[] = NEEDS_FIXES.map((dish) => ({
  ...dish,
  category: dish.category ?? 'Breakfast',
  priceAmount: dish.priceAmount ?? '17',
  servingSize: dish.servingSize ?? '1 serving',
}));

const SAMPLES: Record<string, { label: string; dishes: ReviewDish[]; fails?: boolean }> = {
  fixes: { label: 'Two dishes need fixes (Figma)', dishes: NEEDS_FIXES },
  ready: { label: 'Every dish is Ready (Figma)', dishes: ALL_READY },
  fails: { label: 'Every dish is Ready, completing fails', dishes: ALL_READY, fails: true },
  empty: { label: 'No dishes', dishes: [] },
};

function Demo() {
  const [sample, setSample] = useState('fixes');
  const [state, setState] = useState<ReviewState>(() => initialReview(NEEDS_FIXES));
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [verified, setVerified] = useState(false);
  const [onDashboard, setOnDashboard] = useState(false);
  const current = SAMPLES[sample] ?? SAMPLES.fixes;

  const reset = (id: string) => {
    setSample(id);
    setState(initialReview(SAMPLES[id]?.dishes ?? []));
    setCompleteError(null);
    setNote('');
    setVerified(false);
    setOnDashboard(false);
  };

  // Edit and Add dish change nothing here. They will open the Screen 9 form once Screen 9 is merged
  // into develop (PR #172); until then they only say so.
  const onEditDish = (id: string) => {
    const dish = state.dishes.find((item) => item.id === id);
    setNote(
      `Demo only: Screen 9 (the dish form) opens here for ${dish?.name ?? 'this dish'} once it is merged.`,
    );
  };

  const onAddDish = () => {
    setNote('Demo only: Screen 9 (the dish form) opens here, empty, once it is merged.');
  };

  const onCompleteVerification = () => {
    if (current?.fails) {
      // Interim wording for the demo only; real copy is not in Figma yet.
      setCompleteError('We could not complete verification. Please try again.');
      return;
    }
    setCompleteError(null);
    setNote('');
    // Shows the "Menu verified" pop-up. Nothing is published.
    setVerified(true);
  };

  const onGoToDashboard = () => {
    setVerified(false);
    setOnDashboard(true);
    setNote('Demo only: this is S12 after verification. Nothing was published.');
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
        {onDashboard && (
          <button type="button" onClick={() => setOnDashboard(false)}>
            Back to menu review (demo)
          </button>
        )}
        <span role="status">{note}</span>
      </aside>
      {onDashboard ? (
        <FirstDashboard
          setup={AFTER_VERIFICATION}
          onOpenStep={() => setNote('Demo only: would open that step.')}
          onNavigate={() => setNote('Demo only: would open that page.')}
        />
      ) : (
        <ReviewDishes
          restaurantName={RESTAURANT}
          state={state}
          completeError={completeError}
          onAddDish={onAddDish}
          onEditDish={onEditDish}
          onRemoveDish={(id) => setState(removeDish(state, id))}
          onUndoRemove={() => setState(undoRemove(state))}
          onCancel={() => setNote('Demo only: would go back to Screen 8.')}
          onSaveAndExit={() =>
            setNote('Demo only: would save progress and open the first-time dashboard.')
          }
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
createRoot(root).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
