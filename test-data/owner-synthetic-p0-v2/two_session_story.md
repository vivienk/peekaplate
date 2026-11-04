# PeekaPlate P0 Two-Session Story (Fictional Draft)

**Status:** Proposed fixture for review. Event-field mapping and final product definitions remain subject to approval.

## Dishes

- `dish-A`: Soup
- `dish-B`: Salad
- `dish-C`: Bowl

## Session X

1. The menu renders.
2. Soup and Salad receive valid card exposures.
3. Soup is opened through its actual card exposure.
4. At 5 active seconds, a cumulative activity checkpoint records `5000` milliseconds.
5. Soup is saved directly from its detail view; the Saved-list size becomes 1.
6. Before entering Compare, Soup's final cumulative active-time checkpoint records `10000` milliseconds. Time spent in the picker is excluded.
7. Soup and Salad are displayed side by side in a comparison, linked to the Soup opening.
8. Salad is saved directly from Compare; the Saved-list size becomes 2. This does not create a Salad detail opening.
9. Soup is removed from Saved; the size becomes 1.
10. Undo successfully restores Soup using a `dish_saved` event with `save_origin=undo`; the size becomes 2.
11. Salad is removed from Saved; the size becomes 1. Toast expiry creates no additional event.
12. Session X ends with Soup saved.

## Session Y

1. The menu renders.
2. Soup, Salad, and Bowl receive valid card exposures.
3. Salad is opened through its actual card exposure.
4. Salad is saved directly from its detail view at 2 active seconds; the Saved-list size becomes 1.
5. Salad is removed from Saved at 3 active seconds; the size becomes 0.
6. The final cumulative activity checkpoint records `5000` milliseconds for the Salad opening.
7. Session Y ends with nothing saved.

## Duplicate delivery

The delivery stream contains one byte-for-byte retry of Session X's successful Undo-restoration event. The retry retains the original event ID and payload. It must not create another unique observation or another Save occurrence.

## Expected fixture checks

- 20 unique observations across the two sessions.
- 21 delivery lines after including the duplicate delivery.
- One actual detail opening for Soup in Session X and one for Salad in Session Y.
- Soup's final active time is 10 seconds; Salad's is 5 seconds.
- The comparison qualifies only when the displayed pair and its link to an actual opening are supported by the fixture evidence.
- Direct saves, Undo restorations, successful removals, and distinct saving sessions are separate measures.
- The two-session example is below the owner-visible behavioral suppression threshold of 10 sessions. Owner-facing behavioral values and small-contributor evidence must remain suppressed.

## Boundaries and pending decisions

- This is fictional offline test data, not a production schema or database import.
- Do not infer identity, motivation, allergies, preferences, orders, revenue, or waste.
- Ingredient interactions, preview events, and unapproved Search or Saved-screen telemetry are outside this P0 story.
- Event/API field mapping and final product metric definitions still require review and approval.
- Preparing this fixture does not prove that dataset generation, production integration, or AI evaluation has passed.