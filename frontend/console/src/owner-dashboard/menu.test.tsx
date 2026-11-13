import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Review, Saved } from './menu';

describe('Screen 8 (Review) and Screen 9 (Saved) menu verification UI', () => {
  const sampleDraft = {
    id: 'test-draft-1',
    name: 'Avocado Toast',
    cat: 'Breakfast',
    price: 14,
    desc: 'Toasted seeded bread with avocado',
    ing: ['Avocado', 'Bread'],
    aiIng: [],
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
