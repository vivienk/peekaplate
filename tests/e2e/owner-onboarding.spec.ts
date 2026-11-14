import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

// FE-05 S05 Restaurant details on the preview-only onboarding demo. The demo stands in for the
// caller and answers saves with the outcome picked in its bar.
const demo = 'http://127.0.0.1:5174/owner-onboarding.html';

const save = (page: Page) => page.getByRole('button', { name: 'Save' });

async function fillRequired(page: Page) {
  await page.getByLabel('Restaurant name').fill('Ember & Stone');
  await page.getByLabel('City').fill('San Francisco');
  await page.getByLabel('Street address').fill('742 Evergreen Terrace');
  await page.getByLabel('Phone number').fill('(555) 234-5678');
}

test('S05 opens empty with Save unavailable until the required fields are valid', async ({
  page,
}) => {
  await page.goto(demo);
  await expect(page.getByRole('heading', { name: 'Restaurant Details', level: 1 })).toBeVisible();
  await expect(page.getByLabel('Restaurant name')).toHaveAttribute('required', '');
  await expect(page.getByLabel('Contact email')).not.toHaveAttribute('required', '');
  await expect(save(page)).toHaveAttribute('aria-disabled', 'true');
  await fillRequired(page);
  await expect(save(page)).not.toHaveAttribute('aria-disabled');
});

test('pressing Save early shows every error and focuses the first', async ({ page }) => {
  await page.goto(demo);
  await save(page).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText(
    'Please correct the highlighted errors before saving.',
  );
  await expect(page.getByLabel('Restaurant name')).toBeFocused();
  await expect(page.getByLabel('Restaurant name')).toHaveAccessibleDescription(
    'Error: Enter your restaurant name',
  );
  await expect(page.getByLabel('City')).toHaveAccessibleDescription('Error: Enter your city');
  await expect(page.getByLabel('Phone number')).toHaveAccessibleDescription(
    'Error: Enter your phone number',
  );
  await expect(page.getByText('Requests sent: 0')).toBeVisible();
});

test('a field error appears when leaving it, and clears once fixed', async ({ page }) => {
  await page.goto(demo);
  const phone = page.getByLabel('Phone number');
  await phone.fill('12');
  await phone.blur();
  await expect(phone).toHaveAccessibleDescription('Error: Enter a valid phone number');
  await phone.fill('(555) 234-5678');
  await expect(phone).not.toHaveAttribute('aria-invalid');
});

test('a valid save shows Saving and then hands over to S06', async ({ page }) => {
  await page.goto(demo);
  await fillRequired(page);
  await save(page).click();
  await expect(page.getByRole('button', { name: 'Saving…' })).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByLabel('City')).toHaveAttribute('readonly', '');
  await expect(
    page.getByRole('heading', { name: 'Choose how to add your menu', level: 1 }),
  ).toBeVisible();
});

test('a failed save keeps the details and says so', async ({ page }) => {
  await page.goto(demo);
  await page.getByLabel('Save answer').selectOption('failed');
  await fillRequired(page);
  await save(page).click();
  await expect(page.getByRole('alert')).toContainText('We couldn’t save your restaurant details');
  await expect(page.getByLabel('City')).toHaveValue('San Francisco');
});

test('from the dashboard, Save needs a change and restoring the value disables it again', async ({
  page,
}) => {
  await page.goto(demo);
  await page.getByLabel('S05 opened from').selectOption('dashboard');
  await expect(page.getByLabel('Restaurant name')).toHaveValue('Ember & Stone');
  await expect(page.getByRole('button', { name: 'Back to dashboard' })).toBeVisible();
  await expect(save(page)).toHaveAttribute('aria-disabled', 'true');
  await page.getByLabel('City').fill('Oakland');
  await expect(save(page)).not.toHaveAttribute('aria-disabled');
  await page.getByLabel('City').fill('San Francisco');
  await expect(save(page)).toHaveAttribute('aria-disabled', 'true');
});

test('choosing a photo previews it and rejects other file types', async ({ page }) => {
  await page.goto(demo);
  const input = page.locator('input[type="file"]');
  await input.setInputFiles({ name: 'menu.gif', mimeType: 'image/gif', buffer: Buffer.from('x') });
  await expect(page.getByText('Choose a JPEG or PNG image')).toBeVisible();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  await input.setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByRole('img', { name: 'Restaurant photo' })).toBeVisible();
  await expect(page.getByText('Change photo')).toBeVisible();
});

test('S05 passes the accessibility scan, with and without errors', async ({ page }) => {
  const scan = async () => {
    const { violations } = await new AxeBuilder({ page })
      .include('.pp-onboard')
      .exclude('.pp-onboard__brand')
      .analyze();
    expect(violations).toEqual([]);
  };
  await page.goto(demo);
  await scan();
  await save(page).focus();
  await page.keyboard.press('Enter');
  await scan();
});

test('on a phone the form fits without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(demo);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});

// FE-06 S06 Choose how to add your menu.
async function openS06(page: Page) {
  await page.goto(demo);
  await page.getByLabel('Screen', { exact: true }).selectOption('s06');
  await expect(
    page.getByRole('heading', { name: 'Choose how to add your menu', level: 1 }),
  ).toBeVisible();
}

test('S06 starts with nothing chosen and Continue unavailable', async ({ page }) => {
  await openS06(page);
  const options = page.getByRole('radiogroup', { name: 'Choose how to add your menu' });
  await expect(options.getByRole('radio')).toHaveCount(3);
  for (const radio of await options.getByRole('radio').all()) await expect(radio).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Continue' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
});

test('S06 allows one choice at a time and Continue opens the matching next screen', async ({
  page,
}) => {
  await openS06(page);
  await page.getByText('Paste URL').click();
  await page.getByText('Upload photos/PDF').click();
  await expect(page.getByRole('radio', { name: 'Upload photos/PDF' })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Paste URL' })).not.toBeChecked();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Upload your menu', level: 1 })).toBeVisible();
});

test('S06 works from the keyboard, and Add manually goes to S09', async ({ page }) => {
  await openS06(page);
  await page.getByRole('radio', { name: 'Paste URL' }).focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: 'Add manually' })).toBeChecked();
  await page.keyboard.press('Enter');
  await expect(page.getByText('In the product this opens S09 Add dish')).toBeVisible();
});

test('S06 Back returns to S05, and S06 passes the accessibility scan', async ({ page }) => {
  await openS06(page);
  const { violations } = await new AxeBuilder({ page })
    .include('.pp-onboard')
    .exclude('.pp-onboard__brand')
    .analyze();
  expect(violations).toEqual([]);
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: 'Restaurant Details', level: 1 })).toBeVisible();
});

// FE-06 S07 Add your menu link. The demo answers imports with the outcome picked in its bar.
async function openS07Link(page: Page, answer = 'accepted') {
  await page.goto(demo);
  await page.getByLabel('Screen', { exact: true }).selectOption('s07-url');
  await page.getByLabel('Import answer').selectOption(answer);
  await expect(page.getByRole('heading', { name: 'Add your menu link', level: 1 })).toBeVisible();
}

const importMenu = (page: Page) => page.getByRole('button', { name: 'Import menu' });

test('S07 link: Import menu waits for a valid address, then shows Loading and opens S08', async ({
  page,
}) => {
  await openS07Link(page);
  await expect(importMenu(page)).toHaveAttribute('aria-disabled', 'true');
  await page.getByLabel('Menu URL').fill('https://www.emberandstonerestaurant.com/diner-menu');
  await expect(importMenu(page)).not.toHaveAttribute('aria-disabled');
  await importMenu(page).click();
  await expect(page.getByRole('button', { name: 'Loading' })).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByText('In the product this opens S08 Processing')).toBeVisible();
  await expect(page.getByText('Requests sent: 1')).toBeVisible();
});

test('S07 link: a wrong address keeps the text and explains the format', async ({ page }) => {
  await openS07Link(page);
  const url = page.getByLabel('Menu URL');
  await url.fill('htt//ember-stone..menu');
  await url.blur();
  await expect(page.getByRole('alert')).toContainText('Invalid Web Address');
  await expect(url).toHaveAccessibleDescription(/starting with http:\/\/ or https:\/\//);
  await expect(url).toHaveValue('htt//ember-stone..menu');
  await expect(importMenu(page)).toHaveAttribute('aria-disabled', 'true');
  await url.fill('https://ember.example/menu');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(importMenu(page)).not.toHaveAttribute('aria-disabled');
  await expect(page.getByText('Requests sent: 0')).toBeVisible();
});

test('S07 link: a private link says so until the owner changes it', async ({ page }) => {
  await openS07Link(page, 'private');
  const url = page.getByLabel('Menu URL');
  await url.fill('https://ember.example/private-menu');
  await importMenu(page).click();
  await expect(page.getByRole('alert')).toContainText('Menu link could not be accessed');
  await expect(url).toHaveValue('https://ember.example/private-menu');
  await expect(importMenu(page)).toHaveAttribute('aria-disabled', 'true');
  await url.fill('https://ember.example/menu');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(importMenu(page)).not.toHaveAttribute('aria-disabled');
});

test('S07 link: an unsupported source points to uploading instead, and Back returns to S06', async ({
  page,
}) => {
  await openS07Link(page, 'unsupported');
  await page.getByLabel('Menu URL').fill('https://ember.example/menu');
  await importMenu(page).click();
  await expect(page.getByRole('alert')).toContainText(
    'This source cannot be imported automatically',
  );
  const { violations } = await new AxeBuilder({ page })
    .include('.pp-onboard')
    .exclude('.pp-onboard__brand')
    .analyze();
  expect(violations).toEqual([]);
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(
    page.getByRole('heading', { name: 'Choose how to add your menu', level: 1 }),
  ).toBeVisible();
});

// FE-06 S07 Upload your menu. The demo uploads chosen files with the outcome picked in its bar.
async function openS07Upload(page: Page, answer = 'progress') {
  await page.goto(demo);
  await page.getByLabel('Screen', { exact: true }).selectOption('s07-upload');
  await page.getByLabel('Upload answer').selectOption(answer);
  await expect(page.getByRole('heading', { name: 'Upload your menu', level: 1 })).toBeVisible();
}

const png = (name: string) => ({
  name,
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
  ),
});

const chooseFiles = (page: Page) => page.getByLabel('Choose file');

test('S07 upload: files show progress, then a preview, and Continue opens S08', async ({
  page,
}) => {
  await openS07Upload(page);
  const next = page.getByRole('button', { name: 'Continue' });
  await expect(next).toHaveAttribute('aria-disabled', 'true');
  await chooseFiles(page).setInputFiles([png('menu-1.png'), png('menu-2.png')]);
  const uploads = page.getByRole('list', { name: 'Uploads' });
  await expect(uploads.getByRole('progressbar')).toHaveCount(2);
  await expect(next).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('heading', { name: 'Preview', level: 2 })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Preview of menu-1.png' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Preview of menu-2.png' })).toBeVisible();
  await expect(next).not.toHaveAttribute('aria-disabled');
  await next.click();
  await expect(page.getByText('In the product this opens S08 Processing')).toBeVisible();
});

test('S07 upload: unsupported and too-large files are not uploaded', async ({ page }) => {
  await openS07Upload(page);
  await chooseFiles(page).setInputFiles({
    name: 'menu.gif',
    mimeType: 'image/gif',
    buffer: Buffer.from('GIF89a'),
  });
  await expect(page.getByRole('alert')).toHaveText('File not supported');
  await expect(chooseFiles(page)).toHaveAccessibleDescription(/File not supported/);
  await chooseFiles(page).setInputFiles({
    name: 'menu.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.alloc(12_000_001),
  });
  await expect(page.getByRole('alert')).toHaveText(
    'This file is too large. Choose a file that is 12 MB or smaller.',
  );
  await expect(page.getByText('Requests sent: 0')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
});

test('S07 upload: a failed file shows the error on that file and Retry uploads it', async ({
  page,
}) => {
  await openS07Upload(page, 'fail');
  await chooseFiles(page).setInputFiles([png('menu-1.png'), png('menu-2.png')]);
  const failed = page.getByRole('listitem').filter({ hasText: 'menu-1.png' });
  await expect(failed.getByRole('alert')).toHaveText('Something went wrong, please try again.');
  await expect(page.getByRole('button', { name: 'Continue' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  const { violations } = await new AxeBuilder({ page })
    .include('.pp-onboard')
    .exclude('.pp-onboard__brand')
    .analyze();
  expect(violations).toEqual([]);
  await page.getByRole('button', { name: 'Retry menu-1.png' }).click();
  await expect(page.getByRole('heading', { name: 'Preview', level: 2 })).toBeVisible();
});

test('S07 upload: Remove and Replace work on each file', async ({ page }) => {
  await openS07Upload(page);
  await chooseFiles(page).setInputFiles([png('menu-1.png'), png('menu-2.png')]);
  await expect(page.getByRole('heading', { name: 'Preview', level: 2 })).toBeVisible();
  await page.getByRole('button', { name: 'Remove menu-2.png' }).click();
  await expect(page.getByRole('img', { name: 'Preview of menu-2.png' })).toHaveCount(0);
  await page.getByLabel('Replace menu-1.png').setInputFiles(png('menu-new.png'));
  await expect(page.getByRole('img', { name: 'Preview of menu-new.png' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Preview of menu-1.png' })).toHaveCount(0);
  const { violations } = await new AxeBuilder({ page })
    .include('.pp-onboard')
    .exclude('.pp-onboard__brand')
    .analyze();
  expect(violations).toEqual([]);
});

test('S07 upload: without a percentage the bar still shows the upload is running', async ({
  page,
}) => {
  await openS07Upload(page, 'unknown');
  await chooseFiles(page).setInputFiles(png('menu-1.png'));
  const bar = page.getByRole('progressbar', { name: 'Upload of menu-1.png' });
  await expect(bar).not.toHaveAttribute('aria-valuenow');
  await expect(page.getByRole('heading', { name: 'Preview', level: 2 })).toBeVisible();
});

test('S07 screens fit a phone without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  for (const screen of ['s07-url', 's07-upload']) {
    await page.goto(demo);
    await page.getByLabel('Screen', { exact: true }).selectOption(screen);
    if (screen === 's07-upload') {
      await chooseFiles(page).setInputFiles([png('Ember_Stone_Diner_Menu01.png')]);
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, screen).toBeLessThanOrEqual(0);
  }
});
