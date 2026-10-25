import { expect, test, type Page } from '@playwright/test';
import { createExample } from '../../src/model/examples';
import { importDocument, pointAtLocalSignaling } from './actions';

test.beforeEach(async ({ context }) => pointAtLocalSignaling(context));

async function openDiagram(page: Page) {
  await page.goto('/');
  await expect(page.getByLabel('Diagram name')).toBeEnabled();
  await importDocument(page, createExample('orders'));
  await expect(page.getByTestId('canvas').getByRole('button', { name: 'Entity Customer', exact: true })).toBeVisible();
}

for (const width of [320, 1440]) for (const colorScheme of ['light', 'dark'] as const) {
  test(`version history keeps typing focused and saves snapshots at ${width}px in ${colorScheme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme });
    await openDiagram(page);
    const trigger = page.getByRole('button', { name: 'Versions', exact: true });
    await trigger.click();
    const modal = page.getByRole('dialog', { name: 'Version history', exact: true });
    const name = modal.getByRole('textbox', { name: 'Version name', exact: true });
    const save = modal.getByRole('button', { name: 'Save version', exact: true });
    await expect(name).toBeFocused();
    await expect(save).toBeDisabled();
    await expect(modal.getByText('No saved versions yet', { exact: true })).toBeVisible();

    const label = 'Before adding invoices';
    await name.press('B');
    await expect(name).toHaveValue('B');
    // Typing presence resets after 700 ms; resuming must preserve every key.
    await page.waitForTimeout(900);
    await name.press('e');
    await expect(name).toHaveValue('Be');
    await page.waitForTimeout(900);
    await name.pressSequentially(label.slice(2), { delay: 15 });
    await expect(name).toBeFocused();
    await expect(name).toHaveValue(label);
    await name.press('Enter');
    await expect(modal.getByRole('status')).toHaveText(`Saved “${label}”.`);
    await expect(name).toHaveValue('');
    await expect(name).toBeFocused();
    await expect(save).toBeDisabled();
    await expect(modal.getByRole('list', { name: 'Saved versions' }).getByRole('listitem')).toHaveCount(1);
    // The row says what the snapshot holds, so restoring is an informed choice.
    await expect(modal.getByRole('listitem').first()).toContainText(/entit/);

    const bounds = (await modal.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(await modal.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(await name.evaluate(node => parseFloat(getComputedStyle(node).height))).toBeGreaterThanOrEqual(44);
    await modal.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(trigger).toBeFocused();

    // Reopening after a reload checks real persistence, not just React state.
    await page.reload();
    await expect(page.getByLabel('Diagram name')).toBeEnabled();
    await trigger.click();
    await expect(modal.getByRole('list', { name: 'Saved versions' })).toContainText(label);
    await modal.getByRole('button', { name: `Delete ${label}`, exact: true }).click();
    await modal.getByRole('button', { name: `Confirm delete ${label}`, exact: true }).click();
    await expect(modal.getByText('No saved versions yet', { exact: true })).toBeVisible();
    await expect(modal.getByRole('status')).toHaveText(`Deleted “${label}”.`);
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();
    await expect(trigger).toBeFocused();
  });
}

test('a failed version save keeps the name draft and reports the error inside the modal', async ({ page }) => {
  await openDiagram(page);
  await page.getByRole('button', { name: 'Versions', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Version history', exact: true });
  const name = modal.getByRole('textbox', { name: 'Version name', exact: true });
  await name.fill('Keep this draft');
  await page.evaluate(() => {
    Storage.prototype.setItem = () => { throw new DOMException('Storage is full', 'QuotaExceededError'); };
  });
  await modal.getByRole('button', { name: 'Save version', exact: true }).click();
  await expect(modal.getByRole('alert')).toContainText('Could not save this version');
  await expect(name).toHaveValue('Keep this draft');
  await expect(modal.getByText('No saved versions yet', { exact: true })).toBeVisible();
});
