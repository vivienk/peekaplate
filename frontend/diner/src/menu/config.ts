// Fixture or live menu data, chosen by the VITE_MENU_SOURCE build setting.
// Anything other than "live" means fixture, so a missing or mistyped setting can never
// switch a preview or test build onto the real API. Fixture mode sends no requests.
export type MenuMode = 'fixture' | 'live';

export function menuMode(value: unknown): MenuMode {
  return value === 'live' ? 'live' : 'fixture';
}
