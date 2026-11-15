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
    setTimeout: (...args: Parameters<typeof setTimeout>) => globalThis.setTimeout(...args),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(timer),
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
        Array.isArray(observer.options?.threshold) && observer.options.threshold.includes(0.5),
    );
    expect(exposureObserver).toBeDefined();

    const card = exposureObserver?.observed.find(
      (element) =>
        (element as HTMLElement).dataset.dishId === 'a1000000-0000-4000-8000-000000000001',
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

  it('aborts liveArtwork polling and clears its 30s timer when mountMenuScreen remounts from dish detail', async () => {
    vi.stubEnv('VITE_PUBLIC_API_URL', 'https://api.example.test');
    vi.stubGlobal('addEventListener', vi.fn());
    vi.stubGlobal('removeEventListener', vi.fn());
    const publishedMenu = {
      ...createFixtureMenuSource('demo'),
    };
    const loaded = await publishedMenu.load();
    if (loaded.status !== 'ready') throw new Error('Expected ready fixture menu');
    const published = {
      ...loaded.menu,
      source: 'published' as const,
      venueId: '11111111-1111-4111-8111-111111111111',
      categories: loaded.menu.categories.map((cat) => ({
        ...cat,
        dishes: cat.dishes.map((d) => ({
          ...d,
          ingredients: [{ ingredientId: 'ing-1', name: 'coconut', description: null }],
        })),
      })),
    };
    vi.mocked(createFixtureMenuSource).mockImplementation(() => ({
      load: () => Promise.resolve({ status: 'ready', menu: published }),
    }));

    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return Promise.resolve(
        new Response(JSON.stringify({ schemaVersion: 1, icons: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const makeInteractiveContainer = () => {
      const listeners = new Map<string, Array<() => void>>();
      const base = new FakeContainer();
      return {
        get innerHTML() {
          return base.innerHTML;
        },
        set innerHTML(v: string) {
          listeners.clear();
          base.innerHTML = v;
        },
        querySelectorAll(selector: string) {
          return base.querySelectorAll(selector).map((el) => ({
            ...el,
            querySelector: (childSelector: string) => {
              if (childSelector === '.pp-card__open') {
                return {
                  addEventListener: (event: string, fn: () => void) => {
                    const key = `open-dish:${event}`;
                    listeners.set(key, [...(listeners.get(key) ?? []), fn]);
                  },
                };
              }
              return null;
            },
            addEventListener: (event: string, fn: () => void) => {
              const key = `${selector}:${event}`;
              listeners.set(key, [...(listeners.get(key) ?? []), fn]);
            },
          }));
        },
        querySelector(selector: string) {
          if (selector === '.pp-detail__back') {
            return {
              setAttribute: vi.fn(),
              addEventListener: (_event: string, fn: () => void) => {
                listeners.set('.pp-detail__back:click', [fn]);
              },
            };
          }
          return null;
        },
        appendChild: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        triggerClick(selector: string) {
          listeners.get(`${selector}:click`)?.[0]?.();
        },
      };
    };

    const container1 = makeInteractiveContainer();
    mountMenuScreen(container1 as unknown as HTMLElement);
    await new Promise((r) => setTimeout(r, 0));
    expect(container1.innerHTML).toContain('pp-card--dim');

    // Open a published dish detail view and confirm liveArtwork polling starts.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    container1.triggerClick('open-dish');
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(signals[0]?.aborted).toBe(false);

    // Remount mountMenuScreen while the dish detail view is still open.
    const container2 = makeInteractiveContainer();
    mountMenuScreen(container2 as unknown as HTMLElement);
    expect(signals[0]?.aborted).toBe(true);

    // Advancing 30s must not trigger any further polling from the first mount.
    vi.advanceTimersByTime(30_000);
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The new mount can independently open and close dish detail, and normal navigation cleans up.
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 0));
    expect(container2.innerHTML).toContain('pp-card--dim');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    container2.triggerClick('open-dish');
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(signals[1]?.aborted).toBe(false);

    container2.triggerClick('.pp-detail__back');
    expect(signals[1]?.aborted).toBe(true);
    vi.advanceTimersByTime(30_000);
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('prevents an in-flight deferred fetch from mutating either container after mountMenuScreen remounts', async () => {
    vi.stubEnv('VITE_PUBLIC_API_URL', 'https://api.example.test');
    vi.stubGlobal('addEventListener', vi.fn());
    vi.stubGlobal('removeEventListener', vi.fn());
    const loaded = await createFixtureMenuSource('demo').load();
    if (loaded.status !== 'ready') throw new Error('Expected ready fixture menu');
    const published = {
      ...loaded.menu,
      source: 'published' as const,
      venueId: '11111111-1111-4111-8111-111111111111',
      categories: loaded.menu.categories.map((cat) => ({
        ...cat,
        dishes: cat.dishes.map((d) => ({
          ...d,
          ingredients: [{ ingredientId: 'ing-1', name: 'coconut', description: null }],
        })),
      })),
    };
    vi.mocked(createFixtureMenuSource).mockImplementation(() => ({
      load: () => Promise.resolve({ status: 'ready', menu: published }),
    }));

    let resolveFirstFetch!: (res: Response) => void;
    const firstFetchPromise = new Promise<Response>((resolve) => {
      resolveFirstFetch = resolve;
    });
    let callCount = 0;
    const fetchMock = vi.fn(() => {
      callCount++;
      if (callCount === 1) return firstFetchPromise;
      return Promise.resolve(
        new Response(JSON.stringify({ schemaVersion: 1, icons: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const createElementSpy = vi.fn(() => new FakeContainer());
    vi.stubGlobal('document', {
      createElement: createElementSpy,
      body: { appendChild: vi.fn() },
      hidden: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as any);

    const listeners1 = new Map<string, Array<() => void>>();
    const makeContainer = (listeners: Map<string, Array<() => void>>) => {
      const base = new FakeContainer();
      return {
        get innerHTML() {
          return base.innerHTML;
        },
        set innerHTML(v: string) {
          listeners.clear();
          base.innerHTML = v;
        },
        querySelectorAll(selector: string) {
          return base.querySelectorAll(selector).map((el) => ({
            ...el,
            querySelector: (child: string) =>
              child === '.pp-card__open'
                ? {
                    addEventListener: (e: string, fn: () => void) =>
                      listeners.set(`open-dish:${e}`, [
                        ...(listeners.get(`open-dish:${e}`) ?? []),
                        fn,
                      ]),
                  }
                : null,
            addEventListener: () => {},
          }));
        },
        querySelector: () => null,
        appendChild: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
      };
    };

    const container1 = makeContainer(listeners1);
    mountMenuScreen(container1 as unknown as HTMLElement);
    await new Promise((r) => setTimeout(r, 0));
    listeners1.get('open-dish:click')?.[0]?.();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Remount BEFORE the first fetch resolves.
    const listeners2 = new Map<string, Array<() => void>>();
    const container2 = makeContainer(listeners2);
    mountMenuScreen(container2 as unknown as HTMLElement);
    await new Promise((r) => setTimeout(r, 0));
    const html2Before = container2.innerHTML;

    // Now resolve the stale first fetch with an approved icon.
    resolveFirstFetch(
      new Response(
        JSON.stringify({
          schemaVersion: 1,
          icons: [{ label: 'coconut', version: 1, status: 'approved', sha256: 'a'.repeat(64) }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await Promise.resolve();
    await Promise.resolve();

    // Stale fetch must NOT create <img> elements or mutate container2.
    expect(createElementSpy).not.toHaveBeenCalledWith('img');
    expect(container2.innerHTML).toBe(html2Before);

    // New mount's independent detail flow still works.
    listeners2.get('open-dish:click')?.[0]?.();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
