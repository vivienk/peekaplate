import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { dishStatus, type ReviewDish } from '../owner/review/reviewDishes';
import { dishToForm, formToDish } from '../owner/review/reviewForm';
import type { DishFormView } from '../owner-dashboard/DishFormView';
import type { DishDraft } from './api';
import { DishEditor } from './DishEditor';
import {
  dishFromManualDraft,
  dishFromReviewItem,
  emptyManualDish,
  manualSaveCommand,
  reviewCorrection,
} from './dishForm';
import { EXTRACTION_ID, reviewSession } from './fixtures.test-helpers';
import { calibrationPhotoId, confirmedCalibration } from './portionCalibration.test-helpers';

const captured = vi.hoisted(() => ({ props: null as ComponentProps<typeof DishFormView> | null }));
vi.mock('../owner-dashboard/DishFormView', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../owner-dashboard/DishFormView')>();
  return {
    ...actual,
    DishFormView: (props: ComponentProps<typeof DishFormView>) => {
      captured.props = props;
      return <actual.DishFormView {...props} />;
    },
  };
});

const draft = (manual_fields: unknown): DishDraft => ({
  id: 'draft',
  draft_id: 'draft',
  job_id: null,
  origin: 'manual',
  draft_version: 1,
  name: null,
  category: null,
  description: null,
  price_amount: null,
  price_currency: null,
  ingredients: null,
  source_text: null,
  review_warnings: [],
  review_status: 'pending',
  manual_fields,
});
const row = (fields: Partial<ReviewDish>): ReviewDish => ({
  id: 'dish',
  name: 'Soup',
  category: 'Lunch',
  description: null,
  priceAmount: '12',
  ingredients: { status: 'confirmed', items: ['Carrot'] },
  allergens: { status: 'unknown', items: [] },
  photoId: calibrationPhotoId,
  ...fields,
});
const photo = {
  photoId: calibrationPhotoId,
  url: 'blob:saved-original',
  source_sha256: confirmedCalibration.source_sha256,
  source_width_px: confirmedCalibration.source_width_px,
  source_height_px: confirmedCalibration.source_height_px,
};

describe('Serving size means people, independently of plate centimetres', () => {
  it('uses one people field and a separate 28 cm measurement for either one or two people', () => {
    for (const count of ['1', '2']) {
      const html = renderToStaticMarkup(
        <DishEditor
          value={{
            ...emptyManualDish(),
            servingSize: '1 bowl',
            servingCount: count,
            photoId: calibrationPhotoId,
            portionCalibration: confirmedCalibration,
          }}
          calibrationPhoto={photo}
          onChange={() => {}}
          onSave={() => {}}
          onCancel={() => {}}
        />,
      );
      expect(html).toContain('Serving size (people)');
      expect(html).not.toContain('People served');
      expect(html).not.toContain('dish-serving-count');
      expect(html).toMatch(new RegExp(`id="f-size"[^>]+value="${count}"`));
      expect(html).toContain('Plate size (cm)');
      expect(html).toMatch(/id="dish-plate-size"[^>]+value="28"/);
    }
  });

  it('synchronizes a people edit with the canonical count and legacy display, clearing confirmation', () => {
    const onChange = vi.fn();
    renderToStaticMarkup(
      <DishEditor
        value={{
          ...emptyManualDish(),
          servingSize: '1 bowl',
          servingCount: '1',
          photoId: calibrationPhotoId,
          portionCalibration: confirmedCalibration,
        }}
        calibrationPhoto={photo}
        onChange={onChange}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    const props = captured.props!;
    props.setEd({ ...props.ed, draft: { ...props.ed.draft, size: '2' } });
    const next = onChange.mock.lastCall![0];
    expect(next).toMatchObject({ servingSize: '2', servingCount: '2', portionCalibration: null });
    expect(manualSaveCommand(next, 1, crypto.randomUUID()).fields).toMatchObject({
      servingSize: '2',
      servingCount: 2,
    });
    expect(confirmedCalibration.width_mm).toBe(280);
  });

  it('recovers only plain integer legacy counts when the manual count is absent', () => {
    expect(dishFromManualDraft(draft({ servingSize: '2' })).servingCount).toBe('2');
    expect(dishFromManualDraft(draft({ servingSize: '2', servingCount: 1 })).servingCount).toBe(
      '1',
    );
    expect(dishFromManualDraft(draft({ servingSize: '2', servingCount: null })).servingCount).toBe(
      '',
    );
    for (const servingSize of ['1 bowl', '28 cm', '1.5', '1–2', '0', '101']) {
      const form = dishFromManualDraft(draft({ servingSize }));
      expect(form.servingCount).toBe('');
      expect(manualSaveCommand(form, 1, crypto.randomUUID()).fields.servingSize).toBe(servingSize);
    }
  });

  it('does not reinterpret a previous calibrated centimetre value as a legacy people count', () => {
    const fields = { servingSize: '28', portionCalibration: confirmedCalibration };
    expect(dishFromManualDraft(draft(fields)).servingCount).toBe('');
    expect(dishFromManualDraft(draft({ ...fields, servingCount: 2 })).servingCount).toBe('2');
    expect(dishToForm(row(fields)).servingCount ?? '').toBe('');
    const item = reviewSession().items[0]!;
    item.effective.serving_size = '28';
    item.effective.portion_calibration = confirmedCalibration;
    delete item.effective.serving_count;
    expect(dishFromReviewItem(EXTRACTION_ID, item).servingCount).toBe('');
  });

  it('requires a people count in S10 when supplied, without requiring plate measurements', () => {
    expect(dishStatus(row({ servingSize: '1 bowl' })).ready).toBe(false);
    expect(dishStatus(row({ servingSize: null, servingCount: 2 })).ready).toBe(true);
    expect(dishStatus(row({ servingSize: '2', servingCount: null })).ready).toBe(false);
    expect(dishStatus(row({ servingSize: '2' })).ready).toBe(true);
  });

  it('recovers and saves an extracted legacy count without overriding an explicit clear', () => {
    const item = reviewSession().items[0]!;
    item.effective.serving_size = '2';
    delete item.effective.serving_count;
    const form = dishFromReviewItem(EXTRACTION_ID, item);
    expect(form.servingCount).toBe('2');
    expect(reviewCorrection(item, form)).toMatchObject({ serving_count: 2 });
    item.effective.serving_count = null;
    expect(dishFromReviewItem(EXTRACTION_ID, item).servingCount).toBe('');
  });

  it('carries recovered counts through S10 and preserves explicit null authority', () => {
    const previous = row({ servingSize: '2' });
    expect(dishToForm(previous).servingCount).toBe('2');
    expect(formToDish(dishToForm(previous), previous.id, previous)).toMatchObject({
      servingSize: '2',
      servingCount: 2,
    });
    const cleared = row({ servingSize: '2', servingCount: null });
    expect(dishToForm(cleared).servingCount).toBe('');
    expect(formToDish(dishToForm(cleared), cleared.id, cleared).servingCount).toBeNull();
  });

  it('rejects fractional and range counts in both save paths', () => {
    for (const servingCount of ['1.5', '1.0', '1-2', '2 people']) {
      const form = { ...emptyManualDish(), servingCount };
      expect(() => manualSaveCommand(form, 0, crypto.randomUUID())).toThrow();
      expect(() => formToDish(form, 'dish')).toThrow();
    }
  });
});
