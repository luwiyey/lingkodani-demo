import { expect, test, type Page } from '@playwright/test';

const previewUser = {
  id: 'preview-dev-e2e',
  email: 'dev@demo.lingkodani.local',
  name: 'Developer Preview',
  title: 'System Developer',
  phone: '09171234567',
  role: 'developer',
  preferredWorkspace: 'detailed',
  status: 'active',
  barangay: 'Batakil',
  createdAt: '2026-05-26T08:00:00.000Z',
  updatedAt: '2026-05-26T08:00:00.000Z',
} as const;

async function enableDeveloperPreview(page: Page) {
  await page.context().addCookies([
    {
      name: 'lingkod_ani_demo_preview',
      value: '1',
      url: 'http://localhost:3000',
    },
    {
      name: 'lingkod_ani_demo_preview_profile',
      value: encodeURIComponent(JSON.stringify({ role: 'developer', preferredWorkspace: 'detailed' })),
      url: 'http://localhost:3000',
    },
  ]);
  await page.addInitScript((user) => {
    window.localStorage.setItem('lingkodAniDemoPreviewUser', JSON.stringify(user));
  }, previewUser);
}

async function expectAccessiblePageBasics(page: Page) {
  await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 });

  const duplicateIds = await page.locator('[id]').evaluateAll((elements) => {
    const ids = elements.map((element) => element.id).filter(Boolean);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  });
  expect(duplicateIds).toEqual([]);

  const unlabeledFields = await page.locator('input:not([type="hidden"]):not([aria-hidden="true"]), textarea, select').evaluateAll((fields) => (
    fields
      .filter((field) => {
        const id = field.getAttribute('id');
        return !field.getAttribute('aria-label')
          && !field.getAttribute('aria-labelledby')
          && !field.getAttribute('title')
          && !field.closest('label')
          && !(id && document.querySelector(`label[for="${CSS.escape(id)}"]`));
      })
      .map((field) => field.outerHTML.slice(0, 180))
  ));
  expect(unlabeledFields).toEqual([]);

  const imagesWithoutAlt = await page.locator('img:not([alt])').count();
  expect(imagesWithoutAlt).toBe(0);
}

test.describe('Lingkod-Ani critical flows', () => {
  test.describe.configure({ mode: 'serial', timeout: 60_000 });

  test.beforeEach(async ({ page }) => {
    await enableDeveloperPreview(page);
  });

  test('developer preview can open the account management dashboard', async ({ page }) => {
    await page.goto('/dashboard/developer', { waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('heading', { name: 'Pamamahala ng User at Access' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Developer Account', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Buksan ang Aking Account' })).toBeVisible();
  });

  test('reports page exposes custom ranges and farmer demographics', async ({ page }) => {
    await page.goto('/dashboard/reports', { waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('heading', { name: 'Mga Ulat at Pagsusuri' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel('Mula sa petsa')).toHaveValue('2026-03-08');
    await expect(page.getByLabel('Hanggang sa petsa')).toHaveValue('2026-03-15');
    await expect(page.getByRole('button', { name: 'Gamitin ang Petsa' }).first()).toBeVisible();
    await expect(page.getByText('10 SMS', { exact: true })).toBeVisible();

    // Radix tabs switch on mouse-down or keyboard focus, not on a script-level element.click().
    const demographicsTab = page.getByRole('tab', { name: 'Demograpiko ng Magsasaka' });
    await demographicsTab.focus();
    await demographicsTab.press('Enter');
    await expect(demographicsTab).toHaveAttribute('data-state', 'active');
    await expect(page.getByText('Farmers in Scope')).toBeVisible();
    await expect(page.getByText('Average Farmer Age')).toBeVisible();
    await expect(page.getByText('Gender Distribution')).toBeVisible();
    await expect(page.getByText('Top Crop Profiles')).toBeVisible();
  });

  test('barangay analytics explains priorities from a chosen date range', async ({ page }) => {
    await page.goto('/dashboard/oversight', { waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('heading', { name: 'Pagsusuri ng Agrikultura sa Barangay' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Demo data', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Mula')).toBeVisible();
    await expect(page.getByLabel('Hanggang')).toBeVisible();
    await expect(page.getByText('Dapat tutukan ngayon')).toBeVisible();
    await expect(page.getByText('Kalagayan bawat sitio o zone')).toBeVisible();
    await expect(page.getByText('Profile ng mga magsasaka')).toBeVisible();
  });

  test('key government-facing pages meet basic accessibility structure', async ({ page }) => {
    for (const path of [
      '/dashboard/developer',
      '/dashboard/oversight',
      '/dashboard/reports',
      '/dashboard/export-center',
    ]) {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await expectAccessiblePageBasics(page);
    }
  });

  test('export center downloads filtered CSV and PDF exports', async ({ page }) => {
    await page.goto('/dashboard/export-center', { waitUntil: 'domcontentloaded' });

    await expect(page.getByText('Pag-download ng Ulat ayon sa Petsa')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Sariling Saklaw' }).click();
    await page.locator('input[type="date"]').nth(1).fill('2026-05-01');
    await page.locator('input[type="date"]').nth(2).fill('2026-05-26');
    await page.getByRole('button', { name: 'Gamitin ang Saklaw' }).click();

    const csvDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'I-download ang CSV' }).first().click();
    const csv = await csvDownload;
    expect(csv.suggestedFilename()).toContain('.csv');

    const pdfDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'I-download ang PDF' }).first().click();
    const pdf = await pdfDownload;
    expect(pdf.suggestedFilename()).toContain('.pdf');
  });

  test('archive management downloads archive history exports', async ({ page }) => {
    await page.goto('/dashboard/archive-management', { waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('heading', { name: 'Archive Management' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Archive Controls')).toBeVisible();

    const csvDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download CSV' }).first().click();
    const csv = await csvDownload;
    expect(csv.suggestedFilename()).toContain('.csv');

    const pdfDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download PDF' }).first().click();
    const pdf = await pdfDownload;
    expect(pdf.suggestedFilename()).toContain('.pdf');
  });
});
