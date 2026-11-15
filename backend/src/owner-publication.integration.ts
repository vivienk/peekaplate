import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admitMenuBundleHandoff } from './bundle-producer/repository';
import { listPreparedMenus } from './owner-publication';
import {
  approveMenuRevision,
  publishMenu,
  readDinerLink,
  withdrawMenu,
} from './publication-command';

const runtimeUrl = process.env.PEEKAPLATE_DB_TEST_URL;
const adminUrl = process.env.PEEKAPLATE_DB_ADMIN_URL;
describe.skipIf(!runtimeUrl || !adminUrl)('prepared menus through restricted runtime', () => {
  const admin = new Client({ connectionString: adminUrl });
  const runtime = new Client({ connectionString: runtimeUrl });
  const venueId = crypto.randomUUID();
  const other = crypto.randomUUID();
  const owner = crypto.randomUUID();
  const editor = crypto.randomUUID();
  const viewer = crypto.randomUUID();
  const handoff = {
    tenantId: venueId,
    menuId: crypto.randomUUID(),
    menuRevisionId: crypto.randomUUID(),
    contentApprovalId: crypto.randomUUID(),
    assetApprovalId: crypto.randomUUID(),
    contentHash: 'b'.repeat(64),
    assetManifestHash: 'a'.repeat(64),
    bundleUrl: 'https://68d424e7.peekaplate-diner-staging.pages.dev/fixtures/test.json',
  };
  beforeAll(async () => {
    await admin.connect();
    await runtime.connect();
    await admin.query(
      "INSERT INTO app_private.venues(id,name) VALUES($1,'Synthetic preview cafe'),($2,'Other private cafe')",
      [venueId, other],
    );
    await admin.query(
      "INSERT INTO app_private.staff_membership(tenant_id,actor_id,permission) VALUES($1,$2,'owner'),($1,$3,'editor'),($1,$4,'viewer')",
      [venueId, owner, editor, viewer],
    );
    await admitMenuBundleHandoff(admin, handoff);
  });
  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });
  it('requires current owner permission and never leaks other-restaurant admission', async () => {
    for (const actor of [editor, viewer, crypto.randomUUID()])
      await expect(listPreparedMenus(runtime, actor, venueId)).rejects.toMatchObject({
        status: 403,
      });
    await expect(listPreparedMenus(runtime, owner, other)).rejects.toMatchObject({ status: 403 });
    const [menu] = await listPreparedMenus(runtime, owner, venueId);
    expect(menu).toMatchObject({
      menuId: handoff.menuId,
      menuRevisionId: handoff.menuRevisionId,
      reviewVersion: 0,
      publicationVersion: 0,
      publishedRevisionId: null,
    });
  });
  it('supports preview → approval → publication → stable link, replay and withdrawal', async () => {
    const [menu] = await listPreparedMenus(runtime, owner, venueId);
    if (!menu) throw new Error('missing fixture');
    const approval = await approveMenuRevision(runtime, owner, venueId, {
      commandId: crypto.randomUUID(),
      expectedVersion: menu.reviewVersion,
      menuId: menu.menuId,
      menuRevisionId: menu.menuRevisionId,
      contentApprovalId: menu.contentApprovalId,
      assetApprovalId: menu.assetApprovalId,
    });
    const command = {
      commandId: crypto.randomUUID(),
      expectedVersion: menu.publicationVersion,
      menuId: menu.menuId,
      approvalId: approval.approvalId,
    };
    const publication = await publishMenu(runtime, owner, venueId, command);
    expect(await publishMenu(runtime, owner, venueId, command)).toEqual(publication);
    expect(await readDinerLink(runtime, owner, venueId, menu.menuId)).toMatchObject({
      path: expect.stringMatching(/^\/diner\/synthetic_preview_cafe/),
    });
    expect((await listPreparedMenus(runtime, owner, venueId))[0]).toMatchObject({
      reviewVersion: 1,
      publicationVersion: 1,
      publishedRevisionId: menu.menuRevisionId,
    });
    await expect(
      publishMenu(runtime, owner, venueId, { ...command, commandId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    await withdrawMenu(runtime, owner, venueId, {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      menuId: menu.menuId,
    });
    expect((await listPreparedMenus(runtime, owner, venueId))[0]).toMatchObject({
      publicationVersion: 2,
      publishedRevisionId: null,
    });
    await admin.query(
      "UPDATE app_private.staff_membership SET permission='viewer' WHERE tenant_id=$1 AND actor_id=$2",
      [venueId, owner],
    );
    await expect(listPreparedMenus(runtime, owner, venueId)).rejects.toMatchObject({ status: 403 });
    await expect(publishMenu(runtime, owner, venueId, command)).rejects.toMatchObject({
      status: 403,
    });
  });
});
