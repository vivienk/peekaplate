import { describe, expect, it } from 'vitest';
import {
  availablePages,
  canPublish,
  isFirstTimeArrival,
  type OwnerSetup,
  setupProgress,
  setupSteps,
} from './setup';

const base: OwnerSetup = {
  venueId: 'venue-1',
  restaurantName: 'Ember & Stone',
  detailsStatus: 'missing',
  menuAdded: false,
  published: false,
};

describe('owner onboarding setup rules', () => {
  it('nothing done: details and menu open, publish locked with no button', () => {
    const steps = setupSteps(base);
    expect(steps.map((s) => s.state)).toEqual(['current', 'current', 'locked']);
    expect(steps.map((s) => s.status)).toEqual([null, null, null]);
    expect(steps[2]?.action).toBeNull();
    expect(steps[2]?.lockedReason).toBe(
      'Opens after your details are verified and your menu is added.',
    );
    expect(setupProgress(base)).toEqual({
      done: 0,
      total: 3,
      next: { id: 'details', label: 'Add restaurant details' },
      review: null,
    });
  });

  it('details verified (the Figma state): 1 of 3, next is the menu, only step 1 is verified', () => {
    const setup: OwnerSetup = { ...base, detailsStatus: 'verified' };
    const steps = setupSteps(setup);
    expect(steps.map((s) => s.status?.text ?? null)).toEqual(['Verified', null, null]);
    expect(steps[0]?.action).toEqual({ label: 'Edit', disabled: false });
    expect(steps[2]?.lockedReason).toBe('Opens after you add your menu.');
    expect(setupProgress(setup)).toMatchObject({
      done: 1,
      next: { id: 'menu', label: 'Add your menu' },
      review: { id: 'details', label: 'Review restaurant details' },
    });
  });

  it('details submitted: waiting for verification, still editable, not counted as done', () => {
    const setup: OwnerSetup = { ...base, detailsStatus: 'submitted' };
    const [details] = setupSteps(setup);
    expect(details?.state).toBe('waiting');
    expect(details?.status).toEqual({ text: 'Waiting for verification', tone: 'warning' });
    expect(details?.action).toEqual({ label: 'Edit', disabled: false });
    expect(setupProgress(setup)).toMatchObject({ done: 0, next: { id: 'menu' } });
  });

  it('a menu without verified details keeps publishing locked (no early publish control)', () => {
    for (const detailsStatus of ['missing', 'submitted'] as const) {
      const setup: OwnerSetup = { ...base, detailsStatus, menuAdded: true };
      expect(canPublish(setup)).toBe(false);
      expect(setupSteps(setup)[2]).toMatchObject({ state: 'locked', action: null });
    }
    expect(setupSteps({ ...base, menuAdded: true })[2]?.lockedReason).toBe(
      'Opens after we verify your restaurant details.',
    );
  });

  it('verified and menu added: publish is the next step and says not published', () => {
    const setup: OwnerSetup = { ...base, detailsStatus: 'verified', menuAdded: true };
    const steps = setupSteps(setup);
    expect(canPublish(setup)).toBe(true);
    expect(steps[2]).toMatchObject({
      state: 'current',
      status: { text: 'Not published', tone: 'warning' },
      action: { label: 'Start' },
    });
    expect(setupProgress(setup)).toMatchObject({
      done: 2,
      next: { id: 'publish', label: 'Review and publish' },
    });
    expect(isFirstTimeArrival(setup)).toBe(true);
  });

  it('published: setup is finished, Edit only on details and menu', () => {
    const setup: OwnerSetup = {
      ...base,
      detailsStatus: 'verified',
      menuAdded: true,
      published: true,
    };
    const steps = setupSteps(setup);
    expect(setupProgress(setup)).toMatchObject({ done: 3, next: null });
    expect(steps[2]?.status).toEqual({ text: 'Published', tone: 'success' });
    expect(steps.map((s) => s.action?.label ?? null)).toEqual(['Edit', 'Edit', null]);
    expect(isFirstTimeArrival(setup)).toBe(false);
    expect(canPublish(setup)).toBe(false);
  });

  it('the sidebar is limited to Restaurant Setup until publication is confirmed', () => {
    const before: OwnerSetup = { ...base, detailsStatus: 'verified', menuAdded: true };
    expect([...availablePages(before)]).toEqual(['setup']);
    expect([...availablePages({ ...before, published: true })]).toEqual([
      'setup',
      'overview',
      'report',
      'performance',
      'menu',
      'actions',
    ]);
  });
});
