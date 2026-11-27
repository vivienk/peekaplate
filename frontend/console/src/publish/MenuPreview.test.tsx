import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MenuPreview, type MenuPreviewProps } from './MenuPreview';

const render = (props: Partial<MenuPreviewProps> = {}) =>
  renderToStaticMarkup(
    <MenuPreview
      restaurantName="Ember & Stone"
      dishCount={7}
      categoryCount={3}
      dinerUrl="http://127.0.0.1:5173/"
      onBackToEdit={vi.fn()}
      onReviewDishes={vi.fn()}
      onPublish={vi.fn()}
      onGoToDashboard={vi.fn()}
      {...props}
    />,
  );

describe('S13 menu preview states', () => {
  it('preparation keeps the authored phone and link panel without invented counts or publishing', () => {
    const html = render({ preparing: true, dinerUrl: null });
    expect(html).toContain('pp-menu-preview__phone');
    expect(html).toContain('pp-menu-preview__panel');
    expect(html).toContain('Preparing your menu');
    expect(html).not.toContain('7 dishes');
    expect(html).not.toContain('Publish Menu');
    expect(html).not.toContain('Choose the prepared menu');
  });
  it('draft: no public link before publishing, Publish Menu available', () => {
    const html = render();
    expect(html).toContain('Preview your menu');
    expect(html).toContain('Preview — Not Published');
    expect(html).toContain('Your menu link appears here after you publish.');
    expect(html).not.toContain('Copy Link');
    expect(html).toContain('7 dishes · 3 categories');
    expect(html).not.toMatch(/aria-disabled="true"[^>]*>Publish Menu/);
  });

  it('not ready: explains what is missing and blocks Publish Menu', () => {
    const html = render({ dishesMissingDetails: 2 });
    expect(html).toContain('Your menu isn’t ready to publish');
    expect(html).toContain('2 dishes are missing a price or category.');
    expect(html).toContain('Review dishes');
    expect(html).toMatch(/aria-disabled="true"[^>]*>Publish Menu/);
    expect(render({ dishesMissingDetails: 1 })).toContain('1 dish is missing a price or category.');
  });

  it('failed publish: the menu stays a draft and Publish Menu can be tried again', () => {
    const html = render({ publishFailed: true });
    expect(html).toContain('We couldn’t publish your menu');
    expect(html).toContain('Your menu is still a draft and nothing is public.');
    expect(html).toContain('Preview your menu');
    expect(html).not.toMatch(/aria-disabled="true"[^>]*>Publish Menu/);
  });

  it('published: the returned link, read-only, with Copy Link and Go to dashboard', () => {
    const html = render({ publishedUrl: 'https://peekaplate.app/diner/ember-stone' });
    expect(html).toContain('Your menu is live');
    expect(html).toContain('>Live<');
    expect(html).not.toContain('Published');
    expect(html).toContain('value="https://peekaplate.app/diner/ember-stone"');
    expect(html).toContain('readOnly=""');
    expect(html).toContain('Copy Link');
    expect(html).toContain('Go to dashboard');
    expect(html).not.toContain('Publish Menu');
  });

  it('published but the link could not be read: offers Get diner link, never Publish', () => {
    const html = render({ published: true, publishedUrl: null, onRetryLink: vi.fn() });
    expect(html).toContain('Your menu is live');
    expect(html).toContain('Get diner link');
    expect(html).not.toContain('Publish Menu');
  });
});
