import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  vi.unstubAllGlobals();
});

async function mountAndWait(container: FakeContainer): Promise<void> {
  mountMenuScreen(container as unknown as HTMLElement);
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('menu screen category visibility', () => {
  it('shows only the first category, hiding the rest with the hidden attribute', async () => {
    const container = new FakeContainer();

    await mountAndWait(container);

    const tags = extractCategoryTags(container.innerHTML);
    expect(tags.length).toBeGreaterThan(1);

    // First category should not have hidden
    expect(tags[0]).not.toContain('hidden');

    // All other categories should have hidden
    for (let i = 1; i < tags.length; i++) {
      expect(tags[i]).toContain('hidden');
    }
  });

  it('renders category tabs matching each category', async () => {
    const container = new FakeContainer();

    await mountAndWait(container);

    // Count tab buttons (one per category)
    const tabs = (container.innerHTML.match(/<button[^>]*data-category-id/g) ?? []).length;
    const categories = extractCategoryTags(container.innerHTML).length;

    expect(tabs).toBe(categories);
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
});
