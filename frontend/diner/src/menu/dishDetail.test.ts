import { describe, expect, it, vi } from 'vitest';
import { renderDishDetail } from './dishDetail';
import type { CompleteDish } from './types';

const NOTE = 'For allergy questions, please ask the restaurant staff.';

const render = (allergens: string[], name = 'Leaf', icons: unknown[] = []): string => {
  const container = {
    innerHTML: '',
    querySelector: () => null,
    querySelectorAll: () => icons,
  } as unknown as HTMLElement;
  renderDishDetail(
    container,
    {
      kind: 'complete',
      dishId: 'd',
      dishRevisionId: 'r',
      categoryId: 'c',
      categoryName: 'Cat',
      name: 'Dish',
      description: 'Desc',
      price: { amount: '1.00', currency: 'USD' },
      ingredients: [{ ingredientId: 'i', name, description: null }],
      allergens,
      dietary: [],
      images: null,
    } as unknown as CompleteDish,
    () => {},
  );
  return container.innerHTML;
};

const count = (html: string) => html.split(NOTE).length - 1;

describe('dish detail allergen note', () => {
  it('renders Figma decoration with its visible ingredient label', () => {
    const html = render([], 'Avocado');
    expect(html).toContain('class="pp-ingredient__icon"');
    expect(html).toContain('alt="" aria-hidden="true"');
    expect(html).toContain('class="pp-ingredient__name">Avocado</p>');
  });

  it('retains text for missing or unreviewed generated art and escapes labels', () => {
    expect(render([], 'Coconut')).not.toContain('class="pp-ingredient__icon"');
    expect(render([], 'Coconut')).toContain('class="pp-ingredient__name">Coconut</p>');
    expect(render([], '<img onerror="x">')).toContain('&lt;img onerror=&quot;x&quot;&gt;');
  });

  it('removes failed images without removing the label', () => {
    const remove = vi.fn();
    const handlers: Record<string, () => void> = {};
    const html = render([], 'Avocado', [
      {
        complete: false,
        naturalWidth: 0,
        remove,
        addEventListener: (name: string, callback: () => void) => {
          handlers[name] = callback;
        },
      },
    ]);
    if (!handlers.error) throw new Error('Missing image error handler');
    handlers.error();
    expect(remove).toHaveBeenCalledOnce();
    expect(html).toContain('class="pp-ingredient__name">Avocado</p>');
    render([], 'Avocado', [{ complete: true, naturalWidth: 0, remove, addEventListener: vi.fn() }]);
    expect(remove).toHaveBeenCalledTimes(2);
  });
  it('shows the note once, under Contains, when no allergens are confirmed', () => {
    const html = render([]);
    expect(count(html)).toBe(1);
    expect(html).not.toContain('pp-chip-group');
    expect(html.indexOf('Contains')).toBeLessThan(html.indexOf(NOTE));
  });

  it('shows chips under Contains and the note once, after them, when confirmed', () => {
    const html = render(['Milk']);
    expect(count(html)).toBe(1);
    expect(html).toContain('Milk');
    expect(html.indexOf('pp-chip-group')).toBeLessThan(html.indexOf(NOTE));
  });

  it('never says there are no allergens', () => {
    expect(render([]).toLowerCase()).not.toContain('no allergens');
  });
});
