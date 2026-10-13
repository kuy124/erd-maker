import { expect, test, type Page } from '@playwright/test';
import { Buffer } from 'node:buffer';
import { createExample } from '../../src/model/examples';
import { parseShareHash, ROOM_ID_LENGTH } from '../../src/model/snapshot';
import { allNodes, type ErdDocument } from '../../src/model/types';
import {
  addNamedEntity,
  documentAction,
  inspectSelection,
  pointAtLocalSignaling,
  shape,
  signalingContext,
  snapshotShareLink,
} from './actions';

test.beforeEach(async ({ context }) => {
  await pointAtLocalSignaling(context);
});

/** Waits for the app to mount, then leaves the page on whatever room it chose. */
async function openRoom(page: Page) {
  await page.goto('/');
  await expect(page.getByLabel('Diagram name')).toBeEnabled();
}

async function openOrders(page: Page, doc = createExample('orders'), url = '/') {
  await page.goto(url);
  await expect(page.getByLabel('Diagram name')).toBeEnabled();
  await page.locator('input[type=file]').setInputFiles({
    name: 'orders.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)),
  });
  await expect(shape(page, 'Entity Customer')).toBeVisible();
}

for (const width of [320, 1440]) {
  test(`short and snapshot share links copy the selected URL at ${width}px`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 900 });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openOrders(page);
    await documentAction(page, 'Share');
    const checkbox = page.getByRole('checkbox', { name: 'Include diagram snapshot', exact: true });
    await expect(checkbox).not.toBeChecked();
    const short = await page.getByLabel('Share link').inputValue();
    expect(new URL(short).hash).toMatch(new RegExp('^#room=[a-z2-9]{' + ROOM_ID_LENGTH + '}$'));
    expect(parseShareHash(new URL(short).hash).doc).toBeUndefined();
    await page.getByRole('button', { name: 'Copy link', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Link copied', exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(short);

    const portable = await snapshotShareLink(page);
    expect(portable.length).toBeGreaterThan(short.length);
    expect(parseShareHash(new URL(portable).hash).doc?.entities.map((entity) => entity.name)).toEqual(['Customer', 'Order']);
    await page.getByRole('button', { name: 'Copy link', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Link copied', exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(portable);
    await checkbox.uncheck();
    await expect(page.getByLabel('Share link')).toHaveValue(short);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await documentAction(page, 'Share');
    await expect(checkbox).not.toBeChecked();
    await expect(page.getByLabel('Share link')).toHaveValue(short);
  });
}

test('a short URL joins the live diagram in a separate browser context', async ({ page: alice, browser }) => {
  const doc = createExample('orders');
  for (const node of allNodes(doc)) { node.x += 3500; node.y += 1800; }
  await openOrders(alice, doc);
  await documentAction(alice, 'Share');
  const link = await alice.getByLabel('Share link').inputValue();
  expect(new URL(link).hash).not.toContain('&d=');
  await alice.getByRole('button', { name: 'Done', exact: true }).click();

  const other = await browser.newContext();
  await other.addInitScript(() => {
    (window as unknown as { __ERD_SIGNALING__: string[] }).__ERD_SIGNALING__ = ['ws://127.0.0.1:4444'];
  });
  const bob = await other.newPage();
  try {
    await bob.goto(link);
    await expect(shape(bob, 'Entity Customer')).toBeVisible({ timeout: 25_000 });
    await expect(bob.getByLabel('Diagram name')).toHaveValue('Customer & Order — example');
    await expect.poll(async () => {
      const box = (await shape(bob, 'Entity Customer').boundingBox())!;
      const canvas = (await bob.getByTestId('canvas').boundingBox())!;
      return box.x >= canvas.x && box.y >= canvas.y && box.x + box.width <= canvas.x + canvas.width && box.y + box.height <= canvas.y + canvas.height;
    }).toBe(true);
    await shape(bob, 'Entity Customer').click();
    await inspectSelection(bob);
    await bob.getByLabel('Entity name').fill('Customer accounts');
    await expect(shape(alice, 'Entity Customer accounts')).toBeVisible();
    await bob.reload();
    await expect(shape(bob, 'Entity Customer accounts')).toBeVisible();
  } finally {
    await other.close();
  }
});

test('an explicit snapshot opens the diagram with no signaling or local room data', async ({ page, browser }) => {
  await openOrders(page);
  await documentAction(page, 'Share');
  const link = await snapshotShareLink(page);
  const offline = await browser.newContext();
  await offline.routeWebSocket('**/*', (socket) => socket.close());
  const restored = await offline.newPage();
  try {
    await restored.goto(link);
    await expect(shape(restored, 'Entity Customer')).toBeVisible();
    await expect(shape(restored, 'Entity Order')).toBeVisible();
    await expect(restored.getByLabel('Diagram name')).toHaveValue('Customer & Order — example');
  } finally {
    await offline.close();
  }
});

test('short links retain a query-configured collaboration server', async ({ browser }) => {
  const owner = await browser.newContext();
  const receiver = await browser.newContext();
  const alice = await owner.newPage();
  const bob = await receiver.newPage();
  try {
    await openOrders(alice, createExample('orders'), '/?signaling=ws%3A%2F%2F127.0.0.1%3A4444&temporary=discard');
    await documentAction(alice, 'Share');
    const link = await alice.getByLabel('Share link').inputValue();
    expect(new URL(link).searchParams.get('signaling')).toBe('ws://127.0.0.1:4444');
    expect(new URL(link).searchParams.has('temporary')).toBe(false);
    expect(new URL(link).hash).not.toContain('&d=');
    await bob.goto(link);
    await expect(shape(bob, 'Entity Customer')).toBeVisible({ timeout: 25_000 });
    await expect(bob.getByLabel('Diagram name')).toHaveValue('Customer & Order — example');
  } finally {
    await owner.close();
    await receiver.close();
  }
});

/**
 * An empty canvas means different things depending on how you got here, and
 * guessing wrong is expensive: someone who opened a short link while the owner
 * was offline would otherwise see "start with an entity" and begin drawing a
 * schema that the incoming document replaces.
 */
test('a short link with nobody online waits instead of showing an empty diagram', async ({ browser }) => {
  const owner = await signalingContext(browser);
  let link: string;
  try {
    const alice = await owner.newPage();
    await openRoom(alice);
    await addNamedEntity(alice, 'Owner');
    await documentAction(alice, 'Share');
    link = await alice.getByLabel('Share link').inputValue();
  } finally {
    // The owner leaves before the joiner arrives: this is the whole scenario.
    await owner.close();
  }

  const joiner = await signalingContext(browser);
  const bob = await joiner.newPage();
  try {
    await bob.goto(link);
    await expect(bob.getByRole('heading', { name: 'Waiting for the diagram' })).toBeVisible({ timeout: 30_000 });
    // The room code makes "ask them to reopen it" actionable.
    await expect(bob.locator('.canvas-empty__body code')).toHaveText(new RegExp('^[a-z2-9]{' + ROOM_ID_LENGTH + '}$'));
    // The starter button is the trap: it invites a fresh schema that the
    // incoming document will overwrite.
    await expect(bob.getByRole('button', { name: 'Add your first entity' })).toHaveCount(0);

    // A diagram this browser started itself is genuinely empty, even after a
    // reload — the room id is in the hash in both cases, so only the recorded
    // origin can tell them apart.
    const solo = await signalingContext(browser);
    const alone = await solo.newPage();
    await openRoom(alone);
    await expect(alone.getByRole('heading', { name: 'Start with an entity' })).toBeVisible();
    await expect(alone.getByRole('heading', { name: 'Waiting for the diagram' })).toHaveCount(0);
    await alone.reload();
    await expect(alone.getByRole('heading', { name: 'Start with an entity' })).toBeVisible();
    await solo.close();
  } finally {
    await joiner.close();
  }
});

/**
 * A file is the only way to keep a diagram somewhere other than a live room, so
 * it has to be reachable from the dialog people ask about sharing in.
 */
test('Save a copy downloads the diagram for offline handoff', async ({ page, browser }) => {
  await openOrders(page);
  await documentAction(page, 'Share');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('customer-order-example.json');

  const stream = await file.createReadStream();
  const chunks: Buffer[] = [];
  for await (const part of stream) chunks.push(Buffer.from(part));
  const saved = JSON.parse(Buffer.concat(chunks).toString()) as ErdDocument;
  expect(saved.entities.map((entity) => entity.name)).toEqual(['Customer', 'Order']);

  // It must round-trip through Import into a room, with nobody online.
  const offline = await browser.newContext();
  await offline.routeWebSocket('**/*', (socket) => socket.close());
  const restored = await offline.newPage();
  try {
    await restored.goto('/');
    await expect(restored.getByLabel('Diagram name')).toBeEnabled();
    await restored.locator('input[type=file]').setInputFiles({
      name: file.suggestedFilename(), mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(saved)),
    });
    // A longer budget than the default here, deliberately: this context has every
    // WebSocket closed, so it boots with no transport at all, and the suite runs
    // three workers. It failed once at the 10s default while passing 4/4 alone.
    await expect(shape(restored, 'Entity Customer')).toBeVisible({ timeout: 30_000 });
    await expect(shape(restored, 'Entity Order')).toBeVisible();
  } finally {
    await offline.close();
  }
});

/**
 * Room boundaries.
 *
 * A short link is nothing but the room id, so the only thing separating
 * two diagrams is that the app looks at the right one. A merge would be silent
 * and total, which makes these the tests most worth having and the ones most
 * worth being careful about: every negative assertion here is paired with a
 * positive control in the same test, because "Bob cannot see Alice's entity"
 * also passes when the signalling server is simply down.
 */
test.describe('room boundaries', () => {
  // Three contexts, two of which must complete a WebRTC handshake inside the
  // test. The default budget does not leave room for that.
  test.describe.configure({ timeout: 120_000 });

  test('two rooms on one origin never merge', async ({ browser }) => {
    const aliceContext = await signalingContext(browser);
    const bobContext = await signalingContext(browser);
    const carolContext = await signalingContext(browser);
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    try {
      // Two separate visits to '/': each page is given its own new room id.
      await openRoom(alice);
      await addNamedEntity(alice, 'Alfa');
      await expect(shape(alice, 'Entity Alfa')).toBeVisible();
      await openRoom(bob);
      await addNamedEntity(bob, 'Bravo');
      await expect(shape(bob, 'Entity Bravo')).toBeVisible();

      // Positive control: the transport is working right now, so the isolation
      // assertion below is about rooms rather than about a dead server.
      await documentAction(alice, 'Share');
      const link = await alice.getByLabel('Share link').inputValue();
      expect(parseShareHash(new URL(link).hash).doc).toBeUndefined();
      await alice.getByRole('button', { name: 'Done', exact: true }).click();

      const carol = await carolContext.newPage();
      await carol.goto(link);
      await expect(shape(carol, 'Entity Alfa')).toBeVisible({ timeout: 30_000 });
      await expect(alice.locator('.collaboration-status')).toContainText(/Editing with/, { timeout: 30_000 });

      // Alice's new shape must not reach Bob's room, and Bob must not have
      // gained a peer. The wait is what makes this a real assertion rather
      // than an observation of a diagram that had not finished loading.
      await addNamedEntity(alice, 'Only in room one');
      await bob.waitForTimeout(4000);
      await expect(shape(bob, 'Entity Bravo')).toBeVisible();
      await expect(shape(bob, 'Entity Alfa')).toHaveCount(0);
      await expect(shape(bob, 'Entity Only in room one')).toHaveCount(0);
      await expect(bob.locator('.collaboration-status')).toContainText('Editing alone');
    } finally {
      await aliceContext.close();
      await bobContext.close();
      await carolContext.close();
    }
  });

  test('a third peer joining late by short link receives the whole diagram', async ({ browser }) => {
    const aliceContext = await signalingContext(browser);
    const bobContext = await signalingContext(browser);
    const carolContext = await signalingContext(browser);
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    try {
      await openRoom(alice);
      await addNamedEntity(alice, 'Shared');

      await documentAction(alice, 'Share');
      const link = await alice.getByLabel('Share link').inputValue();
      expect(new URL(link).hash).not.toContain('&d=');
      await alice.getByRole('button', { name: 'Done', exact: true }).click();

      await bob.goto(link);
      await expect(shape(bob, 'Entity Shared')).toBeVisible({ timeout: 30_000 });
      await expect(alice.locator('.collaboration-status')).toContainText(/Editing with/, { timeout: 30_000 });

      // Both peers draw before the third one arrives, so the late joiner can
      // only have the union if the room really converged first.
      await addNamedEntity(alice, 'From Alice');
      await addNamedEntity(bob, 'From Bob');
      for (const page of [alice, bob]) {
        await expect(shape(page, 'Entity From Alice')).toBeVisible({ timeout: 30_000 });
        await expect(shape(page, 'Entity From Bob')).toBeVisible({ timeout: 30_000 });
      }

      const carol = await carolContext.newPage();
      await carol.goto(link);
      for (const name of ['Entity Shared', 'Entity From Alice', 'Entity From Bob']) {
        await expect(shape(carol, name)).toBeVisible({ timeout: 30_000 });
      }
      // Alice now has two peers, which is the presence half of the same fact.
      await expect(alice.locator('.collaboration-status')).toContainText(/Editing with [^,]+, [^,]+/, { timeout: 30_000 });
    } finally {
      await aliceContext.close();
      await bobContext.close();
      await carolContext.close();
    }
  });
});