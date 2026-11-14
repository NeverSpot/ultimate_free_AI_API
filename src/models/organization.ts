import type { DbExecutor } from '../db/client';

export interface Organization {
  id: string;
  name: string;
  owner_id: string;
  created_at: Date;
}

export interface NewOrganization {
  name: string;
  owner_id: string;
}

export function createOrganizationModel(db: DbExecutor) {
  async function createOrg({ name, owner_id }: NewOrganization): Promise<Organization> {
    const result = await db.query<Organization>(
      `insert into organizations (name, owner_id)
       values ($1, $2)
       returning id, name, owner_id, created_at`,
      [name, owner_id],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('createOrg: no row returned');
    }
    await db.query(
      `insert into org_members (org_id, user_id, role)
       values ($1, $2, 'owner')`,
      [row.id, owner_id],
    );
    return row;
  }

  async function isOrgMember(orgId: string, userId: string): Promise<boolean> {
    const result = await db.query<{ org_id: string }>(
      `select 1
       from org_members
       where org_id = $1 and user_id = $2
       limit 1`,
      [orgId, userId],
    );
    return result.rows.length > 0;
  }

  async function addOrgMember(orgId: string, userId: string, role = 'member'): Promise<void> {
    const exists = await isOrgMember(orgId, userId);
    if (exists) {
      return;
    }
    await db.query(
      `insert into org_members (org_id, user_id, role)
       values ($1, $2, $3)`,
      [orgId, userId, role],
    );
  }

  async function listOrgKeys(
    orgId: string,
    userId: string,
  ): Promise<Array<{ id: string; provider: string; fingerprint: string; created_at: string }>> {
    const member = await isOrgMember(orgId, userId);
    if (!member) {
      throw new Error('organization membership required');
    }
    // Block 34 creates organizations + membership only. The dedicated org
    // key-pool table lands in a later block, so there are no keys to list yet.
    return [];
  }

  return { createOrg, listOrgKeys, addOrgMember, isOrgMember };
}

export type OrganizationModel = ReturnType<typeof createOrganizationModel>;
