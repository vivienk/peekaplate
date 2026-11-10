// S4-FE-03 first dashboard arrival (Figma "Owner / 12 First-time Dashboard New", node 2346:6206).
// Pure setup-state rules, so every label on the screen comes from the restaurant's real setup
// facts and nothing is invented. The live API (RES-03) supplies OwnerSetup; this file has no I/O.

export type StepId = 'details' | 'menu' | 'publish';

/** Facts about one restaurant's onboarding, as persisted by the owner API. */
export interface OwnerSetup {
  restaurantName: string;
  /** S05 restaurant details were checked by the PeekaPlate team. */
  detailsVerified: boolean;
  /** At least one dish was saved through S06–S10. */
  menuAdded: boolean;
  /** The owner chose to publish the menu to diners. */
  published: boolean;
  /** Label of the latest report period, only when a report exists (never a placeholder). */
  reportPeriod?: string | null;
}

export type StepState = 'done' | 'current' | 'locked';
export type Tone = 'success' | 'warning';

export interface StepView {
  id: StepId;
  number: 1 | 2 | 3;
  title: string;
  description: string;
  state: StepState;
  /** Status pill shown on the card, or null when the step has nothing to report yet. */
  status: { text: string; tone: Tone } | null;
  /** Button on the card: edit a finished step, start an open one, or wait for a locked one. */
  action: { label: string; disabled: boolean };
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
    description: 'Available after your menu is added. Nothing is published unless you choose to.',
    startLabel: 'Review and publish',
  },
};

const ORDER: StepId[] = ['details', 'menu', 'publish'];

function stateOf(id: StepId, setup: OwnerSetup): StepState {
  if (id === 'details') return setup.detailsVerified ? 'done' : 'current';
  if (id === 'menu') return setup.menuAdded ? 'done' : 'current';
  if (setup.published) return 'done';
  return setup.menuAdded ? 'current' : 'locked';
}

function statusOf(id: StepId, state: StepState): StepView['status'] {
  if (id === 'details' && state === 'done') return { text: 'Verified', tone: 'success' };
  if (id === 'menu' && state === 'done') return { text: 'Added', tone: 'success' };
  if (id === 'publish' && state === 'done') return { text: 'Published', tone: 'success' };
  if (id === 'publish' && state === 'current') return { text: 'Not published', tone: 'warning' };
  return null;
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
      action:
        state === 'done'
          ? { label: 'Edit', disabled: false }
          : { label: 'Start', disabled: state === 'locked' },
    };
  });
}

export interface SetupProgress {
  done: number;
  total: number;
  /** The first open step the owner can act on now, or null when setup is finished. */
  next: { id: StepId; label: string } | null;
  /** A finished step the owner may want to return to (Figma: "Review restaurant details"). */
  review: { id: StepId; label: string } | null;
}

export function setupProgress(setup: OwnerSetup): SetupProgress {
  const steps = setupSteps(setup);
  const nextStep = steps.find((step) => step.state === 'current');
  return {
    done: steps.filter((step) => step.state === 'done').length,
    total: steps.length,
    next: nextStep ? { id: nextStep.id, label: STEP_TEXT[nextStep.id].startLabel } : null,
    review: setup.detailsVerified ? { id: 'details', label: 'Review restaurant details' } : null,
  };
}

/** The first-time arrival is shown until the menu is published. */
export function isFirstTimeArrival(setup: OwnerSetup): boolean {
  return !setup.published;
}
