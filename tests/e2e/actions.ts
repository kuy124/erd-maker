import type { Page } from '@playwright/test';

export async function openBuild(page: Page) {
  if (!await page.getByTestId('rail').isVisible()) {
    await page.getByRole('navigation', { name: 'Workspace panels' }).getByRole('button', { name: 'Build', exact: true }).click();
  }
}

export async function addShape(page: Page, kind: 'entity' | 'attribute' | 'relationship' | 'isa') {
  await openBuild(page);
  await page.getByTestId('add-' + kind).click();
}

export async function documentAction(page: Page, name: 'New' | 'Import' | 'Export' | 'Share') {
  const direct = page.getByRole('button', { name, exact: true });
  if (await direct.isVisible()) await direct.click();
  else {
    await page.getByRole('button', { name: 'Diagram actions', exact: true }).click();
    await page.getByRole('menuitem', { name, exact: true }).click();
  }
}

export async function inspectSelection(page: Page) {
  if (!await page.getByRole('complementary', { name: 'Properties', exact: true }).isVisible()) {
    await page.getByRole('navigation', { name: 'Workspace panels' }).getByRole('button', { name: 'Properties', exact: true }).click();
  }
}
