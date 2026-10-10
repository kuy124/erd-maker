import { expect, test } from '@playwright/test';

/**
 * Visual capture. Not an assertion suite — this writes screenshots so the
 * interface can actually be looked at, which no amount of green tests replaces.
 */

const shot = (name: string) => `test-results/shots/${name}.png`;

test('capture the interface', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('canvas')).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: shot('01-empty-chen'), fullPage: false });

  await page.getByTestId('add-entity').click();
  await page.getByTestId('inspector-name').fill('Customer');
  await page.getByTestId('add-attribute').click();
  await page.getByTestId('inspector-name').fill('customer_id');
  await page.getByRole('button', { name: 'Key', exact: true }).click();

  await page.getByTestId('add-entity').click();
  await page.getByTestId('inspector-name').fill('Order');
  await page.getByTestId('add-attribute').click();
  await page.getByTestId('inspector-name').fill('order_id');
  await page.getByRole('button', { name: 'Key', exact: true }).click();

  await page.getByTestId('add-relationship').click();
  await page.getByTestId('inspector-name').fill('places');

  await page.getByRole('button', { name: 'Tidy' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot('02-chen-diagram') });

  // Select an entity so the inspector is populated.
  await page.getByTestId('canvas').getByRole('button', { name: /Entity Customer/i }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: shot('03-inspector-entity') });

  await page.getByRole('button', { name: "Crow's-foot" }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot('04-crowfoot') });

  await page.getByRole('button', { name: 'Chen' }).click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('tab', { name: 'SQL' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot('05-export-sql') });

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot('06-share') });
  await page.keyboard.press('Escape');

  // Dark mode, which follows the operating system.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot('07-dark-chen') });

  await page.getByRole('button', { name: "Crow's-foot" }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot('08-dark-crowfoot') });
});
