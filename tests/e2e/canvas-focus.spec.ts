import { expect, test } from '@playwright/test';

test('blank canvas focus has no workspace outline in either notation', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Diagram name')).toBeEnabled();
  await page.getByRole('button', { name: 'Add your first entity', exact: true }).click();
  for (const notation of ['Chen', "Crow's-foot"]) {
    const button = page.getByRole('button', { name: notation, exact: true });
    await button.click();
    // Reproduce focus transfer from a text field to the blank workspace.
    await page.getByLabel('Diagram name').focus();
    const canvas = page.getByTestId('canvas');
    await canvas.click({ position: { x: 900, y: 500 } });
    await expect(canvas).toBeFocused();
    await expect(canvas).toHaveCSS('outline-style', 'none');
    await page.getByLabel('Diagram name').focus();
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toHaveCSS('outline-style', 'solid');
  }
});
