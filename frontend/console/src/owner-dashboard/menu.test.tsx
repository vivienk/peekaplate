import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { mergeCategories } from './category-field';
import { newDraft } from './data';
import { DishForm, priceInput, Review, Saved } from './menu';

describe('Screen 8 (Review) and Screen 9 (Saved) menu verification UI', () => {
  const sampleDraft = {
    id: 'test-draft-1',
    name: 'Avocado Toast',
    cat: 'Breakfast',
    price: 14,
    size: '1',
    desc: 'Toasted seeded bread with avocado',
    ing: ['Avocado', 'Bread'],
    aiIng: [],
    alg: ['Gluten'],
    aiAlg: [],
    diet: [],
    upload: 'data:image/png;base64,sample',
    rights: true,
    aiUsed: false,
    aiReviewed: false,
    has25: false,
    status: 'draft' as const,
    dishVerificationStatus: 'not_verified' as const,
    photoVerificationStatus: 'not_verified' as const,
  };

  it('renders Screen 8 with distinct dish verification badge and photo asset badge', () => {
    const html = renderToStaticMarkup(
      <Review
        ed={{ step: 'review', draft: sampleDraft, origId: null }}
        orig={null}
        back={vi.fn()}
        confirm={vi.fn()}
        cancel={vi.fn()}
        onVerifyDish={vi.fn()}
        onApprovePhoto={vi.fn()}
      />,
    );

    expect(html).toContain('Dish Verification: Not verified');
    expect(html).toContain('Photo Asset: Staging (unverified)');
    expect(html).toContain(
      'Verification must never block publishing: unverified dishes can be saved and published at any time.',
    );
    expect(html).toContain('Verify dish');
    expect(html).toContain('Approve &amp; promote photo');
  });

  it('renders Screen 9 with non-blocking publish action enabled for unverified dishes', () => {
    const publish = vi.fn();
    const backToMenu = vi.fn();

    const html = renderToStaticMarkup(
      <Saved m={sampleDraft} publish={publish} backToMenu={backToMenu} />,
    );

    expect(html).toContain('Dish not verified');
    expect(html).toContain('Photo in staging');
    expect(html).toContain('Publish to diner menu');
    expect(html).toContain('Unverified dishes can still be published without blocking.');
  });
});

describe('Screen 9 (Add dish) form', () => {
  const render = (draft: ReturnType<typeof newDraft>) =>
    renderToStaticMarkup(
      <DishForm
        ed={{ step: 'form', draft, origId: null }}
        setEd={vi.fn()}
        orig={null}
        cancel={vi.fn()}
        toReview={vi.fn()}
      />,
    );

  it('starts empty with the Figma fields, allergens and an inactive Continue', () => {
    const html = render(newDraft());
    expect(html).toContain('>Add dish</h1>');
    expect(html).toContain('Select category');
    expect(html).toContain('Serving size (people)');
    expect(html).toContain('Add an allergen');
    expect(html).toContain('Allergens are hidden from diners until you approve them');
    expect(html).toContain('Continue to review');
    expect(html).toMatch(/aria-disabled="true"[^>]*>Continue to review/);
    expect(html).not.toContain('Please correct the highlighted errors');
  });

  it('enables Continue once required fields are filled and AI content is reviewed', () => {
    const html = render({
      ...newDraft(),
      name: 'Avocado Toast',
      cat: 'Breakfast',
      price: '14.00',
      size: '1',
      ing: ['Avocado', 'Maple syrup'],
      aiIng: ['Maple syrup'],
      aiUsed: true,
      aiReviewed: true,
      // The photo is required; an uploaded one also needs the rights confirmation.
      upload: 'data:image/png;base64,iVBORw0KGgo=',
      rights: true,
    });
    expect(html).toMatch(/aria-disabled="false"[^>]*>Continue to review/);
    expect(html).toContain('class="tag ai"');
    expect(html).toContain('>AI<');
  });

  it('shows an optional Dietary dropdown below Allergens', () => {
    const html = render(newDraft());
    expect(html).toMatch(/id="f-diet"[^>]*role="combobox"/);
    expect(html).toContain('>Dietary Info<');
    expect(html).toContain('Select dietary info');
    expect(html).toMatch(/class="pp-field__hint"[^>]*>Select up to 2 options</);
    expect(html).not.toMatch(/id="f-diet"[^>]*aria-required/);
    expect(html.indexOf('id="f-alg"')).toBeLessThan(html.indexOf('id="f-diet"'));
  });

  it('shows the chosen dietary labels in the field', () => {
    const html = render({ ...newDraft(), diet: ['Vegan', 'Gluten-free'] });
    expect(html).toContain('Vegan, Gluten-free');
    expect(html).not.toContain('Select dietary info');
  });

  it('keeps Continue inactive while the photo is missing', () => {
    const html = render({
      ...newDraft(),
      name: 'Avocado Toast',
      cat: 'Breakfast',
      price: '14.00',
      size: '1',
      ing: ['Avocado'],
    });
    expect(html).toMatch(/aria-disabled="true"[^>]*>Continue to review/);
    expect(html).toContain('Photo<span class="pp-visually-hidden"> (required)</span>');
  });

  it('keeps Continue inactive while AI suggestions are unreviewed', () => {
    const html = render({
      ...newDraft(),
      name: 'Avocado Toast',
      cat: 'Breakfast',
      price: '14',
      size: '1',
      ing: ['Avocado'],
      aiUsed: true,
      aiReviewed: false,
      upload: 'data:image/png;base64,iVBORw0KGgo=',
      rights: true,
    });
    expect(html).toMatch(/aria-disabled="true"[^>]*>Continue to review/);
  });
});

describe('Review summary dietary line', () => {
  it('lists dietary labels next to allergens and flags a dietary change', () => {
    const orig = {
      ...newDraft(),
      id: 'd1',
      name: 'Lentil Bowl',
      ing: ['Lentils'],
      diet: ['Vegan'],
    };
    const draft = { ...orig, diet: ['Vegan', 'Gluten-free'] };
    const html = renderToStaticMarkup(
      <Review
        ed={{ step: 'review', draft, origId: 'd1' }}
        orig={orig}
        back={vi.fn()}
        confirm={vi.fn()}
        cancel={vi.fn()}
      />,
    );
    expect(html).toContain('<b>Dietary:</b> Vegan');
    expect(html).toContain('Dietary');
    expect(html).not.toContain('<b>Dietary:</b> Vegan, Gluten-free');
  });
});

describe('Screen 9 price input', () => {
  it('keeps only numbers with one decimal point and two decimals', () => {
    expect(priceInput('14')).toBe('14');
    expect(priceInput('$14.50')).toBe('14.50');
    expect(priceInput('abc')).toBe('');
    expect(priceInput('14.999')).toBe('14.99');
    expect(priceInput('1.2.3')).toBe('1.23');
    expect(priceInput('12 USD')).toBe('12');
  });
});

describe('Screen 9 category list', () => {
  it('keeps every category once, in first-seen order and spelling', () => {
    expect(
      mergeCategories(['Breakfast', 'Salads'], ['breakfast ', '', 'Soups'], ['SOUPS', 'Specials']),
    ).toEqual(['Breakfast', 'Salads', 'Soups', 'Specials']);
  });
});
