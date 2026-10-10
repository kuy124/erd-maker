import { expect, test } from '@playwright/test';

/**
 * Visual capture of the connection gesture mid-flight.
 *
 * The preview line and the two highlight states only exist between a shift-click
 * and the next one, so a screenshot taken after the fact proves nothing about
 * them. This captures the moment itself.
 */

const shot = (name: string) => `test-results/shots/${name}.png`;

test('capture the connection gesture', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('canvas')).toBeVisible();
  await page.waitForTimeout(400);

  const canvas = page.getByTestId('canvas');
  const entity = (label: RegExp) => canvas.getByRole('button', { name: label });

  await page.getByTestId('add-entity').click();
  await page.getByTestId('inspector-name').fill('Customer');
  await page.getByTestId('add-entity').click();
  await page.getByTestId('inspector-name').fill('Order');
  await page.getByTestId('add-relationship').click();
  await page.getByTestId('inspector-name').fill('places');
  await page.getByRole('button', { name: 'Tidy' }).click();
  await page.waitForTimeout(300);

  // Mid-gesture: the source is highlighted and a dashed line follows the pointer.
  await entity(/Entity Customer/i).click({ modifiers: ['Shift'] });
  await page.mouse.move(900, 420);
  await page.waitForTimeout(150);
  await page.screenshot({ path: shot('09-connect-in-progress') });

  // With the pointer over a legal target, the target is filled.
  await entity(/Entity Order/i).hover();
  await page.waitForTimeout(150);
  await page.screenshot({ path: shot('10-connect-target') });

  // Several attributes beside one owner, to show the column.
  await entity(/Entity Customer/i).click();
  await page.getByTestId('add-attribute').click();
  await page.getByTestId('inspector-name').fill('email');
  await page.getByTestId('add-attribute').click();
  await page.getByTestId('inspector-name').fill('name');
  await page.getByRole('button', { name: 'Tidy' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot('11-attributes-column') });
});
