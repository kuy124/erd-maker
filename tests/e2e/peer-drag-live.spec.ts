import { expect, test } from '@playwright/test';
import { addNamedEntity, documentAction, shape, signalingContext } from './actions';

/**
 * Entrance animation attribution.
 *
 * Bloom is for the other side of the room: a shape a peer created arrives
 * after this view opened, so it streams in. The same shape created locally
 * must not bloom on top of the user's own cursor — that reads as the app
 * animating at the person rather than with them. The local-creation path is
 * exactly the one a fast clicker hits a hundred times in a session, so a
 * mistake here is motion with no event behind it, on every edit.
 */
test.describe.configure({ timeout: 120_000 });

test('a shape streams in for the watcher, not for its own creator', async ({ browser }) => {
  const aliceContext = await signalingContext(browser);
  const bobContext = await signalingContext(browser);
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  try {
    // A fresh room, so neither side has a baseline of settled shapes. Bob
    // joins by Alice's live link so the two pages are in the same room.
    await alice.goto('/');
    await expect(alice.getByLabel('Diagram name')).toBeEnabled();
    await documentAction(alice, 'Share');
    await alice.getByRole('checkbox', { name: 'Include diagram snapshot', exact: true }).uncheck();
    const link = await alice.getByLabel('Share link').inputValue();
    await alice.getByRole('button', { name: 'Done', exact: true }).click();
    await bob.goto(link);

    // Name hers so the entity is hers alone; create it, and wait for the
    // round trip before measuring, so the classes are settled on both sides
    // rather than mid-flight.
    await addNamedEntity(alice, 'Alfa');
    await expect(shape(alice, 'Entity Alfa')).toBeVisible();
    await expect(shape(bob, 'Entity Alfa')).toBeVisible({ timeout: 30_000 });

    // The watcher sees the shape bloom; the creator does not.
    await expect(shape(bob, 'Entity Alfa')).toHaveClass(/\bnode--enter-entity\b/);
    await expect(shape(alice, 'Entity Alfa')).not.toHaveClass(/\bnode--enter-entity\b/);

    // A second shape verifies it was not a one-off of joining order.
    await addNamedEntity(alice, 'Bravo');
    await expect(shape(alice, 'Entity Bravo')).toBeVisible();
    await expect(shape(bob, 'Entity Bravo')).toBeVisible({ timeout: 30_000 });
    await expect(shape(bob, 'Entity Bravo')).toHaveClass(/\bnode--enter-entity\b/);
    await expect(shape(alice, 'Entity Bravo')).not.toHaveClass(/\bnode--enter-entity\b/);
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});
