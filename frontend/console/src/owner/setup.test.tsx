import { describe, expect, it } from 'vitest';
import { isFirstTimeArrival, type OwnerSetup, setupProgress, setupSteps } from './setup';

const base: OwnerSetup = {
  restaurantName: 'Ember & Stone',
  detailsVerified: false,
  menuAdded: false,
  published: false,
};

describe('first dashboard setup rules', () => {
  it('nothing done: details and menu open, publish locked, no step labelled verified', () => {
    const steps = setupSteps(base);
    expect(steps.map((s) => s.state)).toEqual(['current', 'current', 'locked']);
    expect(steps.map((s) => s.status)).toEqual([null, null, null]);
    expect(steps[2]?.action).toEqual({ label: 'Start', disabled: true });
    expect(setupProgress(base)).toEqual({
      done: 0,
      total: 3,
      next: { id: 'details', label: 'Add restaurant details' },
      review: null,
    });
  });

  it('details verified (the Figma state): 1 of 3, next is the menu, only step 1 is verified', () => {
    const setup = { ...base, detailsVerified: true };
    const steps = setupSteps(setup);
    expect(steps.map((s) => s.status?.text ?? null)).toEqual(['Verified', null, null]);
    expect(steps[0]?.action).toEqual({ label: 'Edit', disabled: false });
    expect(setupProgress(setup)).toMatchObject({
      done: 1,
      next: { id: 'menu', label: 'Add your menu' },
      review: { id: 'details', label: 'Review restaurant details' },
    });
  });

  it('verified but unpublished: publish is the next step and says not published', () => {
    const setup = { ...base, detailsVerified: true, menuAdded: true };
    const steps = setupSteps(setup);
    expect(steps[2]?.state).toBe('current');
    expect(steps[2]?.status).toEqual({ text: 'Not published', tone: 'warning' });
    expect(setupProgress(setup)).toMatchObject({
      done: 2,
      next: { id: 'publish', label: 'Review and publish' },
    });
    expect(isFirstTimeArrival(setup)).toBe(true);
  });

  it('a menu added before details are verified keeps details as the next step', () => {
    const setup = { ...base, menuAdded: true };
    expect(setupProgress(setup)).toMatchObject({ done: 1, next: { id: 'details' } });
    expect(setupSteps(setup)[2]?.state).toBe('current');
  });

  it('published: setup is finished and the first-time arrival ends', () => {
    const setup = { ...base, detailsVerified: true, menuAdded: true, published: true };
    expect(setupProgress(setup)).toMatchObject({ done: 3, next: null });
    expect(setupSteps(setup)[2]?.status).toEqual({ text: 'Published', tone: 'success' });
    expect(isFirstTimeArrival(setup)).toBe(false);
  });
});
