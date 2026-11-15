// Owner onboarding rules (S4-FE-03 first dashboard, S6-FE-14 onboarding and published-state
// navigation; Figma "Owner / 12 First-time Dashboard New", node 2346:6206).
// Pure setup-state rules, so every label on the screen comes from the restaurant's real setup
// facts and nothing is invented. The owner API supplies OwnerSetup; this file has no I/O.

export type StepId = 'details' | 'menu' | 'publish';

/** Pages of the owner workspace (the sidebar). */
export type OwnerPage = 'setup' | 'overview' | 'report' | 'performance' | 'menu' | 'actions';

/**
 * Where the S05 restaurant details are:
 * - missing: the owner has not sent them yet;
 * - submitted: sent, waiting for the PeekaPlate team to check them;
 * - verified: checked by the team (this never makes anything visible to diners).
 */
export type DetailsStatus = 'missing' | 'submitted' | 'verified';

/** Facts about one restaurant's onboarding, as persisted by the owner API. */
export interface OwnerSetup {
  /** The venue these facts belong to; every owner API call is scoped to it. */
  venueId: string;
  restaurantName: string;
  detailsStatus: DetailsStatus;
  /** At least one dish was saved through S06–S10. */
  menuAdded: boolean;
  /** Publication of the menu to diners was confirmed by the API (Step 3). */
  published: boolean;
  /** Label of the latest report period, only when a report exists (never a placeholder). */
  reportPeriod?: string | null;
}

export type StepState = 'done' | 'waiting' | 'current' | 'locked';
/** Tones of Rania's "Status Label" component (Figma 2721:12212) that onboarding uses. */
export type Tone = 'success' | 'warning' | 'information' | 'neutral';

export interface StepView {
  id: StepId;
  number: 1 | 2 | 3;
  title: string;
  description: string;
  state: StepState;
  /** Status pill shown on the card, or null when the step has nothing to report yet. */
  status: { text: string; tone: Tone } | null;
  /**
   * Button on the card, or null when the owner may not act on the step. Finished steps only offer
   * Edit where editing is allowed; a locked step has no button, so there is no early publish control.
   */
  action: { label: 'Start' | 'Edit'; disabled: false } | null;
  /** Why a locked step is locked (shown instead of a button). */
  lockedReason: string | null;
}

const STEP_TEXT: Record<StepId, { title: string; description: string; startLabel: string }> = {
  details: {
    title: 'Restaurant details',
    description:
      'Name, address and opening hours. We check these before anything is shown to diners.',
    startLabel: 'Add restaurant details',
  },
  menu: {
    title: 'Add your menu',
    description:
      'List your dishes and ingredients so diners can see allergen and dietary information.',
    startLabel: 'Add your menu',
  },
  publish: {
    title: 'Review and publish',
    description:
      'Available after your details are verified and your menu is added. Nothing is published unless you choose to.',
    startLabel: 'Review and publish',
  },
};

const ORDER: StepId[] = ['details', 'menu', 'publish'];

export function isVerified(setup: OwnerSetup): boolean {
  return setup.detailsStatus === 'verified';
}

/** Publishing opens only when the team verified the details and at least one dish exists. */
export function canPublish(setup: OwnerSetup): boolean {
  return isVerified(setup) && setup.menuAdded && !setup.published;
}

function stateOf(id: StepId, setup: OwnerSetup): StepState {
  if (id === 'details') {
    if (setup.detailsStatus === 'verified') return 'done';
    return setup.detailsStatus === 'submitted' ? 'waiting' : 'current';
  }
  if (id === 'menu') return setup.menuAdded ? 'done' : 'current';
  if (setup.published) return 'done';
  return canPublish(setup) ? 'current' : 'locked';
}

function statusOf(id: StepId, state: StepState): StepView['status'] {
  if (state === 'waiting') return { text: 'Waiting for verification', tone: 'information' };
  if (id === 'details' && state === 'done') return { text: 'Verified', tone: 'success' };
  if (id === 'menu' && state === 'done') return { text: 'Added', tone: 'success' };
  if (id === 'publish' && state === 'done') return { text: 'Published', tone: 'success' };
  if (id === 'publish' && state === 'current') return { text: 'Not published', tone: 'warning' };
  return null;
}

function lockedReasonOf(setup: OwnerSetup): string {
  if (!isVerified(setup) && !setup.menuAdded)
    return 'Opens after your details are verified and your menu is added.';
  if (!isVerified(setup)) return 'Opens after we verify your restaurant details.';
  return 'Opens after you add your menu.';
}

function actionOf(id: StepId, state: StepState): StepView['action'] {
  if (state === 'locked') return null;
  // Publishing cannot be edited from here; the published menu is changed through the Menu page.
  if (id === 'publish' && state === 'done') return null;
  if (state === 'done' || state === 'waiting') return { label: 'Edit', disabled: false };
  return { label: 'Start', disabled: false };
}

export function setupSteps(setup: OwnerSetup): StepView[] {
  return ORDER.map((id, index) => {
    const state = stateOf(id, setup);
    const text = STEP_TEXT[id];
    return {
      id,
      number: (index + 1) as StepView['number'],
      title: text.title,
      description: text.description,
      state,
      status: statusOf(id, state),
      action: actionOf(id, state),
      lockedReason: state === 'locked' ? lockedReasonOf(setup) : null,
    };
  });
}

export interface SetupProgress {
  done: number;
  total: number;
  /** The first open step the owner can act on now, or null when nothing is open. */
  next: { id: StepId; label: string } | null;
  /** Details the owner may want to return to (Figma: "Review restaurant details"). */
  review: { id: StepId; label: string } | null;
}

export function setupProgress(setup: OwnerSetup): SetupProgress {
  const steps = setupSteps(setup);
  const nextStep = steps.find((step) => step.state === 'current');
  return {
    done: steps.filter((step) => step.state === 'done').length,
    total: steps.length,
    next: nextStep ? { id: nextStep.id, label: STEP_TEXT[nextStep.id].startLabel } : null,
    review:
      setup.detailsStatus === 'missing'
        ? null
        : { id: 'details', label: 'Review restaurant details' },
  };
}

/** The first-time arrival (onboarding) lasts until publication is confirmed. */
export function isFirstTimeArrival(setup: OwnerSetup): boolean {
  return !setup.published;
}

const ALL_PAGES: readonly OwnerPage[] = [
  'setup',
  'overview',
  'report',
  'performance',
  'menu',
  'actions',
];

/**
 * Sidebar pages the owner may open. Before Step 3 publication only Restaurant Setup is open; the
 * restricted pages unlock only after the API confirms publication.
 */
export function availablePages(setup: OwnerSetup): ReadonlySet<OwnerPage> {
  return new Set(setup.published ? ALL_PAGES : (['setup'] as const));
}

/**
 * Pages listed in the sidebar. Restaurant Setup is hidden once the menu is published (standup,
 * 10 Nov), so a finished owner is not sent back into onboarding; the other pages are always listed.
 */
export function visiblePages(setup: OwnerSetup): ReadonlySet<OwnerPage> {
  return new Set(setup.published ? ALL_PAGES.filter((page) => page !== 'setup') : ALL_PAGES);
}
