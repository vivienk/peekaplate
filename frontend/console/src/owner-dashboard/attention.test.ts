import { describe, expect, it } from 'vitest';
import { ANSWERS, attentionRanking, DISH, QUICK, type Dish } from './data';

const dish = (over: Partial<Dish>): Dish => ({ ...(DISH[0] as Dish), ...over });

describe('Which dishes are getting the most attention?', () => {
  it('ranks by visits that opened the dish after seeing it, not by total opens', () => {
    const ranked = attentionRanking();
    expect(ranked.map((r) => r.dish.name).slice(0, 3)).toEqual([
      'Brioche French Toast',
      'Classic Eggs Benedict',
      'Salmon Poke Bowl',
    ]);
    // Brioche has the fewest opens but is opened in 55 of the 140 visits that show it.
    expect(ranked[0]).toMatchObject({ opened: 55, seen: 140 });
  });

  it('counts a visit once however often it reopened the dish', () => {
    const [only] = attentionRanking([dish({ open: 30, again: 10, seen: 40 })]);
    expect(only).toMatchObject({ opened: 20, seen: 40, rate: 0.5 });
  });

  it('leaves out dishes seen in fewer than ten visits, like the owner report', () => {
    const ranked = attentionRanking([
      dish({ id: 'a', name: 'A', open: 5, again: 0, seen: 9 }),
      dish({ id: 'b', name: 'B', open: 5, again: 0, seen: 10 }),
    ]);
    expect(ranked.map((r) => r.dish.name)).toEqual(['B']);
  });

  it('answers with the top dishes, their rates and the definition used', () => {
    const answer = ANSWERS.top?.();
    expect(answer?.short).toBe(
      'Brioche French Toast (39%) and Classic Eggs Benedict (37%) were opened most often after diners saw them this week.',
    );
    expect(answer?.secs[0]?.items).toContain(
      'Brioche French Toast: opened in 55 of 140 visits that showed it (39%)',
    );
    expect(answer?.ev[0]).toContain('visits that opened the dish ÷ visits that showed it');
    expect(answer?.secs[1]?.k).toBe('unk');
  });
});


describe('verified-order availability', () => {
  it('reports verified orders as unavailable rather than inventing a value', () => {
    const answer = ANSWERS.orders!();

    expect(answer.short).toContain('Verified orders are unavailable');
    expect(answer.short).toContain('No eligible verified order or checkout source');
    expect(answer.secs.map((section) => section.k)).not.toContain('ver');
    expect(answer.secs.flatMap((section) => section.items).join(' ')).toContain(
      'status MISSING',
    );
    expect(answer.ev.join(' ')).toContain('MISSING');
  });

  it('does not promote unavailable verified orders as a quick question', () => {
    expect(QUICK).not.toContain('orders');
  });
});
