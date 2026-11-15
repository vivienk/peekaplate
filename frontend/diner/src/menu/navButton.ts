// Figma "Nav Button" (Design System, Back Nav Button / Close): a 42px round icon button with
// Default, Hover, Focus, Pressed and Disabled states from the --pp-role-nav-* tokens. The icon is
// drawn in the button's colour; the accessible name always comes from the button's aria-label.
const BACK_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M15 5l-7 7 7 7"/></svg>';
const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>';

export function navButtonMarkup(kind: 'back' | 'close', className: string, label: string): string {
  const icon = kind === 'back' ? BACK_ICON : CLOSE_ICON;
  return `<button class="pp-nav-btn ${className}" type="button" aria-label="${label}">${icon}</button>`;
}
