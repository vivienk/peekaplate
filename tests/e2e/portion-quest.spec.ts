import { expect, test } from '@playwright/test';

test('Quest offers immersive entry without requesting a phone camera, rejection preserves back and photo', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla OculusBrowser/35' });
    Object.defineProperty(navigator, 'xr', {
      value: {
        isSessionSupported: async () => true,
        requestSession: async (_mode: string, options: XRSessionInit) => {
          Object.assign(window, { questOptions: options });
          throw new Error('User denied session');
        },
      },
    });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => {
        Object.assign(window, { unexpectedCamera: true });
        throw new Error('No camera');
      },
    });
  });
  await page.goto(
    (process.env.PEEKAPLATE_UPLOAD_URL || 'http://127.0.0.1:5175/') + '?experience=menu',
  );
  await page.getByRole('button', { name: 'Open Avocado Toast', exact: true }).click();
  await page.getByRole('button', { name: 'View Portion', exact: true }).click();
  const portal = page.getByRole('dialog', { name: 'Dish on your table' });
  await portal.getByRole('button', { name: 'Enter Quest mixed reality' }).click();
  expect(
    await page.evaluate(
      () => (window as unknown as { unexpectedCamera?: boolean }).unexpectedCamera,
    ),
  ).toBeUndefined();
  expect(
    await page.evaluate(
      () => (window as unknown as { questOptions: XRSessionInit }).questOptions.requiredFeatures,
    ),
  ).toBeUndefined();
  await portal.getByRole('button', { name: 'Original photo', exact: true }).click();
  await expect(portal.locator('.pp-ar__original')).toBeVisible();
  await portal.getByRole('button', { name: 'Back to preview', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Back to dish details', exact: true }),
  ).toBeVisible();
});

test('spatial controls can be selected by ray without DOM overlay', async ({ page }) => {
  await page.goto(process.env.PEEKAPLATE_UPLOAD_URL || 'http://127.0.0.1:5175/');
  const actions = await page.evaluate(async () => {
    // @ts-expect-error Vite serves source modules in this local browser integration test.
    const { createPortionXRPanel } = await import('/src/menu/portionXR.ts');
    const panel = createPortionXRPanel();
    panel.mesh.visible = true;
    panel.mesh.updateMatrixWorld();
    panel.update('Place dish', 'Approximate', 'Show 3D');
    // Reuse Three classes through mesh geometry rather than a second Three module instance.
    const results = [];
    for (let index = 0; index < 5; index++) {
      const y = (0.5 - (110 + index * 86 + 37) / 640) * 0.4;
      const origin = panel.mesh.position.clone().set(0, y, 1);
      const direction = origin.clone().set(0, 0, -1);
      // Raycaster copies the origin/direction from this structural ray.
      results.push(panel.select({ origin, direction }));
    }
    return results;
  });
  expect(actions).toEqual(['mode', 'rotate', 'reset', 'original', 'close']);
});
