import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { OrganizationModel } from '../../models/organization';

const CreateOrgBody = Type.Object({
  name: Type.String({ minLength: 1 }),
});
const CreateOrgResponse = Type.Object({
  id: Type.String(),
  name: Type.String(),
});
const OrgKeySummary = Type.Object({
  id: Type.String(),
  provider: Type.String(),
  fingerprint: Type.String(),
  created_at: Type.String(),
});
const OrgKeysResponse = Type.Object({
  keys: Type.Array(OrgKeySummary),
});
const Params = Type.Object({
  orgId: Type.String(),
});

function authenticationRequired(): Error & { statusCode: number } {
  const error = new Error('authentication required') as Error & {
    statusCode: number;
  };
  error.statusCode = 401;
  return error;
}

function membershipRequired(): Error & { statusCode: number } {
  const error = new Error('organization membership required') as Error & {
    statusCode: number;
  };
  error.statusCode = 403;
  return error;
}

export default async function organizationsRoute(
  app: FastifyInstance,
  deps: { orgStore: OrganizationModel },
): Promise<void> {
  const server = app.withTypeProvider<TypeBoxTypeProvider>();
  const orgStore = deps.orgStore;

  server.post(
    '/v1/orgs',
    { schema: { body: CreateOrgBody, response: { 201: CreateOrgResponse } } },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        throw authenticationRequired();
      }
      const { name } = request.body as { name: string };
      const org = await orgStore.createOrg({ name, owner_id: user.id });
      return reply.status(201).send({ id: org.id, name: org.name });
    },
  );

  server.get(
    '/v1/orgs/:orgId/keys',
    { schema: { params: Params, response: { 200: OrgKeysResponse } } },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        throw authenticationRequired();
      }
      const { orgId } = request.params as { orgId: string };
      const member = await orgStore.isOrgMember(orgId, user.id);
      if (!member) {
        throw membershipRequired();
      }
      const keys = await orgStore.listOrgKeys(orgId, user.id);
      return reply.status(200).send({ keys });
    },
  );
}
