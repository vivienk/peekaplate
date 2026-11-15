// Figma design-system round buttons (Azoz QA report 03, Finding 3):
// - Back: "Nav Button" (447:7954) on Dish details, Saved dishes and the Compare result view. 42px
//   circle, #FFF8ED at 5% fill and 10% border, 16px solid angle-left chevron.
// - Close: "Close Button" State=Default (683:6577) on the Compare picker and Replace screens. 42px
//   circle, #2D3038 fill, 1px #71737A 30% border, 24px cross-small icon.
// Both use the component's Hover / Focus / Pressed / Disabled variants (the --pp-role-nav-* tokens).
// The icon is drawn in the button's colour; the accessible name always comes from aria-label.
export const BACK_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M10.48 12l5.29-5.29a1.5 1.5 0 0 0-2.12-2.12l-6.36 6.35a1.5 1.5 0 0 0 0 2.12l6.36 6.36a1.5 1.5 0 0 0 2.12-2.12z"/></svg>';
export const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M8 8l8 8M16 8l-8 8"/></svg>';

export function navButtonMarkup(kind: 'back' | 'close', className: string, label: string): string {
  const icon = kind === 'back' ? BACK_ICON : CLOSE_ICON;
  return `<button class="pp-nav-btn pp-nav-btn--${kind} ${className}" type="button" aria-label="${label}">${icon}</button>`;
}
