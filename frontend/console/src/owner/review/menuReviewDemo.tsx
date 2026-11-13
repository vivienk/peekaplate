// Preview-only demo of S10 "Menu Review and Publish" (S5-FE-10) with fictional dishes (PR previews
// only). The owner draft API and the S09 form replace these stand-ins; nothing here is real
// restaurant data. "Publishing" only waits briefly and flips a local flag to show the success pop-up.
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@peekaplate/tokens/tokens.css';
import '@peekaplate/ui/components.css';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '../owner.css';
import './review.css';
import { PublishSuccessDialog } from '../PublishSuccessDialog';
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
const items = (count: number) => Array.from({ length: count }, (_, index) => `item ${index + 1}`);
const confirmed = { status: 'confirmed', items: ['egg'] } as const;
const unknown = { status: 'unknown', items: [] } as const;

const make = (
  id: string,
  name: string,
  category: string | null,
  priceAmount: string | null,
  ingredientCount: number,
  allergens: ReviewDish['allergens'],
): ReviewDish => ({
  id,
  name,
  category,
  priceAmount,
  ingredients: { status: 'confirmed', items: items(ingredientCount) },
  allergens,
});

// The Figma example: 7 dishes, one without a price and one without a category.
const NEEDS_FIXES: ReviewDish[] = [
  make('d1', 'Avocado Toast', 'Breakfast', '14', 6, confirmed),
  make('d2', 'Classic Eggs Benedict', 'Breakfast', '16', 5, unknown),
  make('d3', 'Berry Pancake Stack', 'Breakfast', null, 5, unknown),
  make('d4', 'Brioche French Toast', null, '16', 5, unknown),
  make('d5', 'Harvest Power Bowl', 'Breakfast', '18', 7, confirmed),
  make('d6', 'Salmon Poke Bowl', 'Breakfast', '19', 6, unknown),
  make('d7', 'Garden Avocado Salad', 'Breakfast', '15', 5, confirmed),
];

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
        onAddDish={() => {
          added.current += 1;
          setState(
            addDish(
              state,
              make(
                `new-${added.current}`,
                `New dish ${added.current}`,
                'Breakfast',
                '12',
                4,
                unknown,
              ),
            ),
          );
          setNote('Demo: the empty S09 form would open; saving adds the dish here.');
        }}
        onEditDish={onEditDish}
        onRemoveDish={(id) => setState(removeDish(state, id))}
        onUndoRemove={() => setState(undoRemove(state))}
        onBack={() => setNote('Back: destination still to be confirmed with design.')}
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
