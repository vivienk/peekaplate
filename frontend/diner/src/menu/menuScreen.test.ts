import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFixtureMenuSource } from './fixtures';
import { mountMenuScreen } from './menuScreen';

const { mockTrack } = vi.hoisted(() => ({
  mockTrack: vi.fn(),
}));

vi.mock('../tracking', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tracking')>();
  return {
    ...actual,
    track: mockTrack,
  };
});

const mockObserve = vi.fn();
const mockUnobserve = vi.fn();
// Every observer the screen creates, so a test can check each one individually.
const observers: MockIntersectionObserver[] = [];

class MockIntersectionObserver {
  observed: Element[] = [];
  observe = vi.fn((target: Element) => {
    mockObserve(target);
    this.observed.push(target);
  });
  unobserve = mockUnobserve;
  disconnect = vi.fn();

  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    observers.push(this);
  }

  trigger(target: Element): void {
    this.callback(
      [
        {
          target,
          isIntersecting: true,
          intersectionRatio: 0.75,
        } as IntersectionObserverEntry,
      ],
      this as unknown as IntersectionObserver,
    );
  }
}

// Minimal fake container that supports innerHTML and querySelectorAll
class FakeContainer {
  _html = '';
  get innerHTML(): string {
    return this._html;
  }
  set innerHTML(value: string) {
    this._html = value;
  }
  querySelectorAll(selector: string): HTMLElement[] {
    const classMatch = selector.match(/\.([\w-]+)/);
    if (!classMatch) return [];
    const className = classMatch[1];
    if (!className) return [];
    const elements: HTMLElement[] = [];
    // Extract matching opening tags so each fake card retains its real dish ID.
    const tagRegex = /<[a-z][^>]*>/gi;
    let attrMatch;
    while ((attrMatch = tagRegex.exec(this._html)) !== null) {
      const tag = attrMatch[0];
      const classes = tag.match(/\bclass="([^"]*)"/)?.[1]?.split(/\s+/) ?? [];
      if (classes.includes(className)) {
        const dishId = tag.match(/\bdata-dish-id="([^"]*)"/)?.[1];
        const openDishId = tag.match(/\bdata-open-dish-id="([^"]*)"/)?.[1];
        elements.push({
          className,
          getAttribute: (name: string) =>
            tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? null,
          hasAttribute: () => false,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          querySelector: vi.fn(() => null),
          dataset: { dishId, openDishId },
          isConnected: true,
          closest: () => null,
          classList: {
            add: vi.fn(),
            remove: vi.fn(),
            toggle: vi.fn(),
            contains: vi.fn(() => false),
          },
          style: {},
          focus: vi.fn(),
        } as unknown as HTMLElement);
      }
    }
    return elements;
  }
  // No single-element lookups in this fake; the search wiring then stays inert.
  querySelector(): null {
    return null;
  }
  appendChild() {}
  addEventListener() {}
}

function extractCategoryTags(html: string): string[] {
  const tags: string[] = [];
  const regex = /<div class="pp-category"[^>]*>/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    tags.push(match[0]);
  }
  return tags;
}

beforeEach(() => {
  mockObserve.mockClear();
  mockUnobserve.mockClear();
  observers.length = 0;
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
  vi.stubGlobal('window', {
    location: { search: '?scenario=demo', hash: '' },
    scrollTo: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    get scrollY() {
      return 0;
    },
    setTimeout: (...args: Parameters<typeof setTimeout>) =>
      globalThis.setTimeout(...args),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) =>
      globalThis.clearTimeout(timer),
    IntersectionObserver: MockIntersectionObserver,
  } as any);
  vi.stubGlobal('document', {
    createElement: () => new FakeContainer(),
    body: { appendChild: vi.fn() },
    hidden: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as any);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

vi.mock('./fixtures', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fixtures')>();
  return {
    ...actual,
    // Real behavior by default; the two error tests override one call.
    createFixtureMenuSource: vi.fn(actual.createFixtureMenuSource),
  };
});

async function mountAndWait(container: FakeContainer): Promise<void> {
  mountMenuScreen(container as unknown as HTMLElement);
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('menu screen category visibility', () => {
  it('shows only the All block first, hiding every category block', async () => {
    const container = new FakeContainer();

    await mountAndWait(container);

    const tags = extractCategoryTags(container.innerHTML);
    expect(tags.length).toBeGreaterThan(1);

    // The first block is All, and it is visible.
    expect(tags[0]).toContain('data-category-id="all"');
    expect(tags[0]).not.toContain('hidden');

    // Every category block after it is hidden.
    for (let i = 1; i < tags.length; i++) {
      expect(tags[i]).toContain('hidden');
    }
  });

  it('renders an All tab first, then one tab per category', async () => {
    const container = new FakeContainer();

    await mountAndWait(container);

    const tabs =
      container.innerHTML.match(/<button class="pp-tab[^>]*data-category-id="[^"]*"/g) ?? [];
    const blocks = extractCategoryTags(container.innerHTML).length;

    expect(tabs.length).toBe(blocks);
    expect(tabs[0]).toContain('data-category-id="all"');
  });
});

describe('menu screen observer lifecycle', () => {
  it('disconnects every previous IntersectionObserver when the screen mounts again', async () => {
    const container = new FakeContainer();

    await mountAndWait(container);
    const firstMount = [...observers];
    // The dimming observer and the exposure observer.
    expect(firstMount.length).toBeGreaterThanOrEqual(2);

    await mountAndWait(container);

    for (const observer of firstMount) {
      expect(observer.disconnect).toHaveBeenCalled();
    }
  });

  it('tracks menu_viewed when the fixture menu becomes readable', async () => {
    mockTrack.mockClear();
    const container = new FakeContainer();

    await mountAndWait(container);

    expect(mockTrack).toHaveBeenCalledWith('menu_viewed', {
      publication_revision_id: 'a5000000-0000-4000-8000-000000000001',
      entry_source: 'direct_link',
    });
  });

  it('tracks dish_viewed after a complete dish is at least 50% visible for one second', async () => {
    mockTrack.mockClear();
    const container = new FakeContainer();

    await mountAndWait(container);

    const exposureObserver = observers.find(
      (observer) =>
        Array.isArray(observer.options?.threshold) &&
        observer.options.threshold.includes(0.5),
    );
    expect(exposureObserver).toBeDefined();

    const card = exposureObserver?.observed.find(
      (element) =>
        (element as HTMLElement).dataset.dishId ===
        'a1000000-0000-4000-8000-000000000001',
    );
    expect(card).toBeDefined();

    vi.useFakeTimers();
    exposureObserver!.trigger(card!);
    await vi.advanceTimersByTimeAsync(1000);

    expect(mockTrack).toHaveBeenCalledWith(
      'dish_viewed',
      expect.objectContaining({
        publication_revision_id: 'a5000000-0000-4000-8000-000000000001',
        dish_id: 'a1000000-0000-4000-8000-000000000001',
        surface: 'menu_list',
        position: 1,
        exposure_basis: 'viewport_50pct_1s',
        exposure_id: expect.any(String),
      }),
    );
  });

  it('calls observe on the IntersectionObserver for cards', async () => {
    const container = new FakeContainer();

    await mountAndWait(container);

    const cards = container.querySelectorAll('.pp-card--dim');
    expect(mockObserve).toHaveBeenCalled();
    expect(mockObserve.mock.calls.length).toBeGreaterThanOrEqual(cards.length);
  });

  it('displays error state when load rejects', async () => {
    vi.mocked(createFixtureMenuSource).mockReturnValueOnce({
      load: () => Promise.reject(new Error('boom')),
    });
    const container = new FakeContainer();

    await mountAndWait(container);

    expect(container.innerHTML).toContain('We could not load the menu. Please try again.');
  });

  it('displays error state when renderMenu throws after ready', async () => {
    vi.mocked(createFixtureMenuSource).mockReturnValueOnce({
      load: () =>
        Promise.resolve({
          status: 'ready',
          menu: { categories: null, restaurant: { name: 'Test Restaurant' } },
        } as never),
    });
    const container = new FakeContainer();

    await mountAndWait(container);

    expect(container.innerHTML).toContain('We could not load the menu. Please try again.');
  });

  it('live mode shows no fixture label and no demo restaurant name', async () => {
    vi.stubEnv('VITE_MENU_SOURCE', 'live');
    const container = new FakeContainer();

    mountMenuScreen(container as unknown as HTMLElement);
    // The published adapter is loaded by dynamic import, so wait for the state to appear.
    await vi.waitFor(() =>
      expect(container.innerHTML).toContain('We could not load the menu. Please try again.'),
    );

    expect(container.innerHTML).not.toContain('Fixture data');
    expect(container.innerHTML).not.toContain('Ember & Stone');
  });
});
