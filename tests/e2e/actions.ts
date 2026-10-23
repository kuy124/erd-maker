import { readFile } from 'node:fs/promises';
import type { Browser, BrowserContext, Download, Page } from '@playwright/test';
import { Buffer } from 'node:buffer';
import type { ErdDocument } from '../../src/model/types';

/**
 * Raw bytes of a downloaded file.
 *
 * `createReadStream` races the download and fails with "canceled" when the
 * stream is opened before the body is ready, which it does occasionally under
 * three parallel workers. The saved path is already complete when `path()`
 * resolves, so this does not.
 *
 * Bytes rather than a string: a PNG read as utf8 comes back corrupted, with
 * every byte above 0x7F replaced.
 */
export async function readDownloadBytes(download: Download): Promise<Buffer> {
  const path = await download.path();
  if (!path) throw new Error('the download produced no file');
  return readFile(path);
}

/** The same file as text, for SVG, JSON, and SQL exports. */
export async function readDownload(download: Download): Promise<string> {
  return (await readDownloadBytes(download)).toString('utf8');
}

/** Loads a document through the file picker, the way a person would. */
export async function importDocument(page: Page, doc: ErdDocument, name = 'schema.json') {
  await page.locator('input[type=file]').setInputFiles({
    name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)),
  });
}

/** The signalling server started by `playwright.config.ts`. */
const LOCAL_SIGNALING = 'ws://127.0.0.1:4444';

/**
 * Points a context at the local signalling server before any app code runs.
 *
 * The app reads `window.__ERD_SIGNALING__` at startup, so this has to be an
 * init script rather than an assignment after load. Installing it on the
 * *context* covers every page opened from it, including pages created later.
 */
export async function pointAtLocalSignaling(context: BrowserContext) {
  await context.addInitScript((url) => {
    (window as unknown as { __ERD_SIGNALING__?: string[] }).__ERD_SIGNALING__ = [url];
  }, LOCAL_SIGNALING);
}

/** A fresh context that talks to the local signalling server. */
export async function signalingContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext();
  await pointAtLocalSignaling(context);
  return context;
}

/**
 * A canvas shape by its exact accessible label, e.g. `Entity Customer`.
 *
 * Exact matters: the shape rail has buttons with similar names, and a substring
 * match would silently satisfy the assertion with the wrong element.
 */
export const shape = (page: Page, name: string) =>
  page.getByTestId('canvas').getByRole('button', { name, exact: true });

/** Creates a named entity through the shape rail, the most reliable creation path. */
export async function addNamedEntity(page: Page, name: string) {
  await addShape(page, 'entity');
  await page.getByTestId('inspector-name').fill(name);
}

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

/** Request a portable snapshot explicitly; the share dialog also opens with one by default. */
export async function snapshotShareLink(page: Page) {
  await page.getByRole('checkbox', { name: 'Include diagram snapshot', exact: true }).check();
  return page.getByLabel('Share link').inputValue();
}
