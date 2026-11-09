import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

for (const port of [5173, 5174]) {
  test(`opt-in, private payload, withdrawal and offline usability on ${port}`, async ({ page }) => {
    const bodies: Record<string, unknown>[] = [];
    await page.route('https://us.i.posthog.com/**', async (route) => {
      expect(route.request().headers().referer).toBeUndefined();
      bodies.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, body: '{}' });
    });
    await page.goto(`http://127.0.0.1:${port}/?email=synthetic-private@example.test`);
    const button = page.getByRole('button', { name: 'Allow optional analytics' });
    await expect(button).toBeVisible();
    expect(bodies).toHaveLength(0);
    await button.click();
    if (port === 5173) {
      // The diner uses the shared gate and remains fixture-only until a live menu enables it.
      await expect(page.getByRole('button', { name: 'Turn off optional analytics' })).toBeVisible();
      await page.getByRole('button', { name: 'Turn off optional analytics' }).click();
      await page.reload();
      await expect(button).toBeVisible();
      expect(bodies).toHaveLength(0);
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
      ).toEqual([]);
      return;
    }
    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0]).toMatchObject({
      event: 'app_shell_viewed',
      properties: {
        surface: port === 5173 ? 'diner' : 'console',
        environment: 'staging',
        $process_person_profile: false,
      },
    });
    expect(JSON.stringify(bodies)).not.toContain('synthetic-private');
    await page.getByRole('button', { name: 'Turn off optional analytics' }).click();
    await expect(page.getByRole('status')).toContainText('off');
    await page.reload();
    await expect(button).toBeVisible();
    expect(bodies).toHaveLength(1);
    await page.route('https://us.i.posthog.com/**', (route) => route.abort());
    await button.click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
    ).toEqual([]);
  });
  test(`GPC prevents opt-in traffic on ${port}`, async ({ page }) => {
    let captures = 0;
    await page.route('https://us.i.posthog.com/**', (route) => {
      captures++;
      return route.abort();
    });
    await page.addInitScript(() =>
      Object.defineProperty(navigator, 'globalPrivacyControl', { value: true }),
    );
    await page.goto(`http://127.0.0.1:${port}`);
    await page.getByRole('button', { name: 'Allow optional analytics' }).click();
    await expect(page.getByRole('status')).toContainText('off');
    expect(captures).toBe(0);
  });
}
