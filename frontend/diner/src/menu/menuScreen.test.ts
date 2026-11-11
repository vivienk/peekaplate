import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFixtureMenuSource } from './fixtures';
import { mountMenuScreen } from './menuScreen';

const mockObserve = vi.fn();
const mockUnobserve = vi.fn();
const mockDisconnect = vi.fn();

class MockIntersectionObserver {
  observe = mockObserve;
  unobserve = mockUnobserve;
  disconnect = mockDisconnect;
  constructor() {}
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
    // Extract all class attribute values from the HTML
    const classAttrRegex = /class="([^"]*)"/g;
    let attrMatch;
    while ((attrMatch = classAttrRegex.exec(this._html)) !== null) {
      const classes = (attrMatch[1] ?? '').split(/\s+/);
      if (classes.includes(className)) {
        elements.push({
          className,
          getAttribute: () => null,
          hasAttribute: () => false,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dataset: { dishId: 'test-dish-id' },
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
  mockDisconnect.mockClear();
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
  vi.stubGlobal('window', {
    location: { search: '?scenario=demo' },
    scrollTo: vi.fn(),
    get scrollY() {
      return 0;
    },
    IntersectionObserver: MockIntersectionObserver,
  } as any);
  vi.stubGlobal('document', {
    createElement: () => new FakeContainer(),
    body: { appendChild: vi.fn() },
  } as any);
});

afterEach(() => {
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
  it('disconnects the previous IntersectionObserver before creating a new one on re-render', async () => {
    const container = new FakeContainer();

    // First mount
    await mountAndWait(container);
    const disconnectsAfterFirst = mockDisconnect.mock.calls.length;

    // Second mount: should disconnect the previous observer before creating a new one
    await mountAndWait(container);
    expect(mockDisconnect).toHaveBeenCalledTimes(disconnectsAfterFirst + 1);
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
