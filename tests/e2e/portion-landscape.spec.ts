import { expect, test } from '@playwright/test';

for (const { supported, landscape } of [
  { supported: true, landscape: true },
  { supported: false, landscape: true },
  { supported: false, landscape: false },
]) {
  test(`original actions and landscape portal, orientation API ${supported ? 'supported' : 'unavailable'} ${landscape ? 'landscape' : 'portrait'}`, async ({
    page,
  }) => {
    await page.setViewportSize(
      landscape ? { width: 844, height: 390 } : { width: 390, height: 844 },
    );
    await page.addInitScript((supported) => {
      const original = window.matchMedia.bind(window);
      window.matchMedia = (query) =>
        query === '(pointer: coarse)'
          ? Object.defineProperty(original(query), 'matches', { value: true })
          : original(query);
      let full: Element | null = null;
      const calls = { fullscreen: 0, lock: '', unlock: 0, exit: 0 };
      Object.assign(window, { orientationTest: calls });
      Object.defineProperty(document, 'fullscreenElement', { get: () => full, configurable: true });
      Element.prototype.requestFullscreen = async () => {
        calls.fullscreen++;
        full = document.documentElement;
      };
      document.exitFullscreen = async () => {
        calls.exit++;
        full = null;
      };
      Object.defineProperty(screen.orientation, 'lock', {
        configurable: true,
        value: supported
          ? async (value: string) => {
              calls.lock = value;
            }
          : undefined,
      });
      screen.orientation.unlock = () => {
        calls.unlock++;
      };
      Object.defineProperty(navigator, 'xr', { value: undefined, configurable: true });
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        configurable: true,
        value: async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 640;
          canvas.height = 480;
          const context = canvas.getContext('2d')!;
          context.fillStyle = '#8b7766';
          context.fillRect(0, 0, 640, 480);
          return canvas.captureStream(5);
        },
      });
    }, supported);
    await page.goto(process.env.PEEKAPLATE_UPLOAD_URL || 'http://127.0.0.1:5175/');
    await page.getByRole('button', { name: 'Open Avocado Toast', exact: true }).click();
    const actions = page.locator('.pp-detail__actions');
    await expect(actions.locator(':scope > *')).toHaveCount(2);
    const portion = page.getByRole('button', { name: 'View Portion', exact: true });
    const compare = actions.getByRole('button', { name: 'Compare' });
    const a = await portion.boundingBox(),
      b = await compare.boundingBox();
    expect(a!.y).toBe(b!.y);
    expect(Math.abs(a!.width - b!.width)).toBeLessThanOrEqual(2);
    await portion.click();
    const portal = page.getByRole('dialog', { name: 'Dish on your table' });
    await expect(portal).toBeVisible({ timeout: 20000 });
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { orientationTest: { lock: string } }).orientationTest.lock,
        ),
      )
      .toBe(supported ? 'landscape' : '');
    if (!supported && !landscape)
      await expect(portal.getByText('Rotate your phone sideways to view the dish.')).toBeVisible();
    const box = await portal.boundingBox();
    expect(box!.width).toBe(landscape ? 844 : 390);
    expect(box!.height).toBe(landscape ? 390 : 844);
    await expect(portal.locator('.pp-ar__panel')).not.toBeVisible();
    await expect(portal.getByRole('button', { name: 'Back to preview' })).toHaveClass(
      /pp-ar__back/,
    );
    await page.screenshot({
      path: `/private/tmp/portion-fullscreen-${supported}-${landscape}.png`,
    });
    await portal.getByText('Adjust view', { exact: true }).click();
    await expect(portal.getByRole('slider', { name: 'Rotate dish' })).toBeEnabled();
    await page.screenshot({ path: `/private/tmp/portion-landscape-${supported}-${landscape}.png` });
    await portal.getByRole('button', { name: 'Back to preview', exact: true }).click();
    if (supported)
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { orientationTest: { unlock: number } }).orientationTest.unlock,
          ),
        )
        .toBe(1);
    await page.getByRole('button', { name: 'Back to dish details', exact: true }).click();
    await expect(actions.locator(':scope > *')).toHaveCount(2);
  });
}
