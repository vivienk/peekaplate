// Preview-only controller. Every screen comes from its team's original implementation.
// Local synthetic answers demonstrate navigation; they never assert hosted API acceptance.
import { useEffect, useState } from 'react';
import { FirstDashboard } from '../owner/FirstDashboard';
import { menuItemToReviewDish } from '../owner/review/fromMenuItem';
import { ReviewDishes } from '../owner/review/MenuReview';
import {
  addDish,
  initialReview,
  type ReviewState,
  removeDish,
  saveEdit,
  undoRemove,
} from '../owner/review/reviewDishes';
import { imgOf, initialMenu, type MenuItem, newDraft } from '../owner-dashboard/data';
import { DishForm, type EditState } from '../owner-dashboard/menu';
import { DraftMenu } from '../publish/DraftMenu';
import { MenuPreview } from '../publish/MenuPreview';
import { AddMenuLink } from './AddMenuLink';
import { ChooseMenuSource } from './ChooseMenuSource';
import type { RestaurantDetails as Details } from './details';
import { MenuProcessing } from './MenuProcessing';
import { OnboardingLayout } from './OnboardingLayout';
import { RestaurantDetails } from './RestaurantDetails';
import { type MenuUpload, UploadMenu } from './UploadMenu';
import '../owner-dashboard/owner-dashboard.css';
import '../owner/owner.css';
import '../owner/owner-publish.css';
import '../owner/review/review.css';

type Screen = 's05' | 's06' | 's07-url' | 's07-upload' | 's08' | 's09' | 's10' | 's12' | 's13';
const SCREENS: Record<Screen, string> = {
  s05: 'S05 Restaurant details',
  s06: 'S06 Menu source',
  's07-url': 'S07 Link',
  's07-upload': 'S07 Upload',
  s08: 'S08 Processing',
  s09: 'S09 Add / edit dish',
  s10: 'S10 Review / S11 verification',
  s12: 'S12 Dashboard',
  s13: 'S13 Preview / publish',
};
const SAMPLE: Details = {
  name: 'Ember & Stone',
  city: 'San Francisco',
  street: '742 Evergreen Terrace',
  line2: '',
  phone: '(555) 234-5678',
  email: 'owner@example.test',
};
const samples = () =>
  initialMenu()
    .slice(0, 3)
    .map((dish) => ({ ...dish, size: '1 serving', status: 'draft' as const }));
const toReview = (dish: MenuItem) =>
  menuItemToReviewDish({
    ...dish,
    servingSize: dish.size,
    photoId: imgOf(dish) ? (dish.id ?? 'uploaded-photo') : null,
  });

export function OwnerJourneyDemo() {
  const [screen, setScreen] = useState<Screen>('s05');
  const [details, setDetails] = useState<Details | null>(null);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [review, setReview] = useState<ReviewState>(() => initialReview([]));
  const [editing, setEditing] = useState<Extract<EditState, { step: 'form' | 'review' }> | null>(
    null,
  );
  const [files, setFiles] = useState<MenuUpload[]>([]);
  const [verified, setVerified] = useState(false);
  const [menuVerified, setMenuVerified] = useState(false);
  const [published, setPublished] = useState(false);
  const [detailsVerified, setDetailsVerified] = useState(false);
  const [outcome, setOutcome] = useState<'dishes' | 'no-dishes' | 'failed'>('dishes');
  const [result, setResult] = useState<'processing' | 'no-dishes' | 'failed'>('processing');
  useEffect(() => {
    if (screen !== 's08') return;
    setResult('processing');
    const timer = window.setTimeout(() => {
      if (outcome !== 'dishes') {
        setResult(outcome);
        return;
      }
      const next = samples();
      setItems(next);
      setReview(initialReview(next.map(toReview)));
      setMenuVerified(false);
      setPublished(false);
      setScreen('s10');
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [screen, outcome]);
  const name = details?.name ?? SAMPLE.name;
  const openForm = (id?: string) => {
    const draft = id ? items.find((dish) => dish.id === id) : newDraft();
    if (!draft) return;
    setEditing({ step: 'form', draft: { ...draft }, origId: id ?? null });
    setScreen('s09');
  };
  const visibleItems = items.filter((dish) => review.dishes.some((row) => row.id === dish.id));
  const content = {
    restaurant: { name },
    categories: [...new Set(visibleItems.map((dish) => dish.cat))].map((category) => ({
      category_id: category,
      name: category,
      dishes: visibleItems
        .filter((dish) => dish.cat === category)
        .map((dish) => ({
          complete: true as const,
          dish_id: dish.id ?? dish.name,
          name: dish.name,
          description: dish.desc,
          price: { amount: String(dish.price), currency: 'USD' },
          images: { card: { url: imgOf(dish), alt: dish.name } },
          ingredients: dish.ing.map((name) => ({ name })),
          allergens: dish.alg.length ? dish.alg : null,
        })),
    })),
  };
  const setup = {
    venueId: 'preview-only',
    restaurantName: name,
    detailsStatus: detailsVerified
      ? ('verified' as const)
      : details
        ? ('submitted' as const)
        : ('missing' as const),
    menuAdded: visibleItems.length > 0,
    published,
  };
  const onboarding = (body: React.ReactNode, bare = false) => (
    <OnboardingLayout restaurantName={name} bare={bare}>
      {body}
    </OnboardingLayout>
  );
  return (
    <>
      <aside className="pp-auth-demo" aria-label="Journey preview controls">
        <p>
          <strong>Synthetic S05–S13 walkthrough.</strong> No account, uploads, extraction,
          verification or publication requests are sent. Refresh resets this demo. Hosted acceptance
          is separate.
        </p>
        <div className="pp-auth-demo__choices">
          <label>
            Screen{' '}
            <select
              value={screen}
              onChange={(event) => {
                const next = event.target.value as Screen;
                if (next === 's09') {
                  openForm();
                  return;
                }
                setScreen(next);
              }}
            >
              {Object.entries(SCREENS).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Extraction answer{' '}
            <select
              value={outcome}
              onChange={(event) => setOutcome(event.target.value as typeof outcome)}
            >
              <option value="dishes">Dishes found</option>
              <option value="no-dishes">No dishes</option>
              <option value="failed">Failure</option>
            </select>
          </label>
          <button
            type="button"
            onClick={() => {
              const next = samples();
              setItems(next);
              setReview(initialReview(next.map(toReview)));
              setMenuVerified(false);
              setPublished(false);
              setScreen('s10');
            }}
          >
            Load fictional review dishes
          </button>
          <label>
            <input
              type="checkbox"
              checked={detailsVerified}
              onChange={(event) => setDetailsVerified(event.target.checked)}
            />
            Simulate team verification of restaurant details
          </label>
        </div>
      </aside>
      {screen === 's05' &&
        onboarding(
          <RestaurantDetails
            mode={details ? 'dashboard' : 'onboarding'}
            saved={details ?? undefined}
            onSave={(next) => {
              const returning = Boolean(details);
              setDetails(next);
              setDetailsVerified(false);
              setScreen(returning ? 's12' : 's06');
            }}
            onLeave={() => setScreen('s12')}
          />,
        )}
      {screen === 's06' &&
        onboarding(
          <ChooseMenuSource
            onContinue={(source) => {
              if (source === 'manual') openForm();
              else setScreen(source === 'url' ? 's07-url' : 's07-upload');
            }}
            onBack={() => setScreen('s05')}
          />,
        )}
      {screen === 's07-url' &&
        onboarding(
          <AddMenuLink onImport={() => setScreen('s08')} onBack={() => setScreen('s06')} />,
        )}
      {screen === 's07-upload' &&
        onboarding(
          <UploadMenu
            files={files}
            onAdd={(chosen) =>
              setFiles((current) => [
                ...current,
                ...chosen.map((file) => ({
                  id: crypto.randomUUID(),
                  name: file.name,
                  size: file.size,
                  kind: file.type === 'application/pdf' ? ('pdf' as const) : ('image' as const),
                  status: 'uploaded' as const,
                })),
              ])
            }
            onRemove={(id) => setFiles((current) => current.filter((file) => file.id !== id))}
            onReplace={(id, file) =>
              setFiles((current) =>
                current.map((entry) =>
                  entry.id === id ? { ...entry, name: file.name, size: file.size } : entry,
                ),
              )
            }
            onRetry={() => {}}
            onContinue={() => setScreen('s08')}
            onBack={() => setScreen('s06')}
          />,
          true,
        )}
      {screen === 's08' &&
        onboarding(
          <MenuProcessing
            state={result}
            onCancel={() => setScreen('s12')}
            onTryAnother={() => setScreen('s06')}
          />,
        )}
      {screen === 's09' &&
        editing &&
        onboarding(
          <div className="owner-menu-design">
            <DishForm
              ed={editing}
              orig={items.find((dish) => dish.id === editing.origId) ?? null}
              setEd={(next) => {
                if (next.step === 'form' || next.step === 'review') setEditing(next);
              }}
              cancel={() => setScreen('s10')}
              toReview={() => {
                const draft = { ...editing.draft, id: editing.origId ?? crypto.randomUUID() };
                const next = editing.origId
                  ? items.map((dish) => (dish.id === editing.origId ? draft : dish))
                  : [...items, draft];
                setItems(next);
                setReview((state) =>
                  editing.origId
                    ? saveEdit(state, toReview(draft))
                    : addDish(state, toReview(draft)),
                );
                setMenuVerified(false);
                setPublished(false);
                setScreen('s10');
              }}
            />
          </div>,
          true,
        )}
      {screen === 's10' && (
        <ReviewDishes
          restaurantName={name}
          state={review}
          onAddDish={() => openForm()}
          onEditDish={openForm}
          onRemoveDish={(id) => {
            setReview((state) => removeDish(state, id));
            setMenuVerified(false);
          }}
          onUndoRemove={() => setReview(undoRemove)}
          onCancel={() => setScreen('s06')}
          onSaveAndExit={() => setScreen('s12')}
          onCompleteVerification={() => {
            setMenuVerified(true);
            setVerified(true);
          }}
          verified={verified}
          onGoToDashboard={() => {
            setVerified(false);
            setScreen('s12');
          }}
        />
      )}
      {screen === 's12' && (
        <div className="owner-root">
          <FirstDashboard
            setup={setup}
            onNavigate={(page) => {
              if (page === 'menu') setScreen('s10');
            }}
            onOpenStep={(step) =>
              setScreen(step === 'details' ? 's05' : step === 'menu' ? 's10' : 's13')
            }
          />
        </div>
      )}
      {screen === 's13' && (
        <MenuPreview
          restaurantName={name}
          dishCount={visibleItems.length}
          categoryCount={content.categories.length}
          dinerUrl={null}
          phoneContent={<DraftMenu preview={{ content }} />}
          dishesMissingDetails={!menuVerified || !detailsVerified || !visibleItems.length ? 1 : 0}
          notReadyBody="Complete dish review and simulate team verification in the labelled demo controls first."
          panelNote="Synthetic navigation demo only. The example link is not a published restaurant."
          published={published}
          publishedUrl={published ? 'https://peekaplate.app/diner/example-only' : null}
          onBackToEdit={() => setScreen('s10')}
          onReviewDishes={() => setScreen('s10')}
          onPublish={() => setPublished(true)}
          onGoToDashboard={() => setScreen('s12')}
        />
      )}
    </>
  );
}
