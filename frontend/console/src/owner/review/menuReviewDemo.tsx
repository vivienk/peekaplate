// Preview-only demo of S10 "Menu Review and Publish" (S5-FE-10) with fictional dishes (PR previews
// only). The dishes come from the owner dashboard's menu data (the data behind its Menu screen), so
// S10 and that screen show the same menu. The owner draft API and the S09 form replace these
// stand-ins; nothing here is real restaurant data. "Publishing" only waits briefly and flips a
// local flag to show the success pop-up.
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@peekaplate/tokens/tokens.css';
import '@peekaplate/ui/components.css';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '../owner.css';
import './review.css';
import { initialMenu, newDraft } from '../../owner-dashboard/data';
import { PublishSuccessDialog } from '../PublishSuccessDialog';
import { type DashboardMenuItem, menuItemToReviewDish } from './fromMenuItem';
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
  initialMenu().map((item) => ({ ...item, alg: ALLERGENS[item.id ?? ''] ?? [] }));

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
}));

const SAMPLES: Record<string, { label: string; dishes: ReviewDish[]; fails?: boolean }> = {
  fixes: { label: 'Two dishes need fixes (Figma)', dishes: NEEDS_FIXES },
  ready: { label: 'Every dish is Ready (Figma)', dishes: ALL_READY },
  fails: { label: 'Every dish is Ready, publishing fails', dishes: ALL_READY, fails: true },
  empty: { label: 'No dishes', dishes: [] },
};

function Demo() {
  const [sample, setSample] = useState('fixes');
  const [state, setState] = useState<ReviewState>(() => initialReview(NEEDS_FIXES));
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [published, setPublished] = useState(false);
  const [note, setNote] = useState('');
  const timer = useRef<number | undefined>(undefined);
  const added = useRef(0);
  const current = SAMPLES[sample] ?? SAMPLES.fixes;

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const reset = (id: string) => {
    window.clearTimeout(timer.current);
    setSample(id);
    setState(initialReview(SAMPLES[id]?.dishes ?? []));
    setPublishing(false);
    setPublishError(null);
    setPublished(false);
    setNote('');
  };

  const onEditDish = (id: string) => {
    const dish = state.dishes.find((item) => item.id === id);
    if (!dish) return;
    // Demo only: the real S09 form opens here. Saving fills in whatever is missing.
    setState(
      saveEdit(state, {
        ...dish,
        category: dish.category ?? 'Breakfast',
        priceAmount: dish.priceAmount ?? '17',
      }),
    );
    setNote(`Demo: S09 would open for ${dish.name ?? 'this dish'}; saving returns here.`);
  };

  const onAddDish = () => {
    added.current += 1;
    const dish = menuItemToReviewDish({
      ...newDraft(),
      id: `new-${added.current}`,
      name: `New dish ${added.current}`,
      price: '12',
      ing: ['Rice', 'Mixed greens', 'Avocado', 'Sesame'],
    });
    setState(addDish(state, dish));
    setNote('Demo: the empty S09 form would open; saving adds the dish here.');
  };

  const onPublish = () => {
    setPublishError(null);
    setPublishing(true);
    timer.current = window.setTimeout(() => {
      setPublishing(false);
      if (current?.fails) {
        setPublishError('We could not publish your menu. Please try again.');
        return;
      }
      setPublished(true);
    }, 700);
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
        <span role="status">{note}</span>
      </aside>
      <ReviewDishes
        restaurantName={RESTAURANT}
        state={state}
        publishing={publishing}
        publishError={publishError}
        onAddDish={onAddDish}
        onEditDish={onEditDish}
        onRemoveDish={(id) => setState(removeDish(state, id))}
        onUndoRemove={() => setState(undoRemove(state))}
        onCancel={() => setNote('Cancel: behavior not specified in Figma yet (to confirm).')}
        onSaveAndExit={() => setNote('Demo: progress saved; would return to S12.')}
        onPublish={onPublish}
      />
      {published && (
        <PublishSuccessDialog
          restaurantName={RESTAURANT}
          onClose={() => {
            setPublished(false);
            setNote('Demo: Go to dashboard would open S12.');
          }}
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
