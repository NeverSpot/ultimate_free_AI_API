import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { ApiError } from '../errors';
import { getSpendCap, setSpendCap, type SpendCapPeriod } from '../../models/spend-cap';

const Params = Type.Object({
  orgId: Type.String(),
});
type ParamsType = Static<typeof Params>;

const Body = Type.Object({
  userId: Type.String(),
  capUsd: Type.Number(),
  period: Type.Optional(Type.Union([Type.Literal('daily'), Type.Literal('monthly')])),
});
type BodyType = Static<typeof Body>;

const CapResponse = Type.Object({
  orgId: Type.String(),
  capUsd: Type.Number(),
  period: Type.String(),
});

const ErrorResponse = Type.Object({
  error: Type.Object({
    message: Type.String(),
  }),
});

type SpendCapQuery = { userId?: string; period?: string };

function requireNonEmpty(fields: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new ApiError('client', `${name} is required`);
    }
  }
}

export function registerSpendCapRoutes(app: FastifyInstance): void {
  const server = app.withTypeProvider<TypeBoxTypeProvider>();

  server.get(
    '/v1/orgs/:orgId/spend-cap',
    {
      schema: {
        params: Params,
        querystring: Type.Object({
          userId: Type.String(),
          period: Type.Optional(Type.String()),
        }),
        response: { 200: CapResponse, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      const params = request.params as ParamsType;
      const query = request.query as SpendCapQuery;
      requireNonEmpty({ orgId: params.orgId, userId: query.userId });
      const period = (query.period ?? 'monthly') as SpendCapPeriod;
      const cap = await getSpendCap(params.orgId, period);
      if (!cap) {
        return reply
          .status(404)
          .send({ error: { message: `No spend cap configured for org ${params.orgId}` } });
      }
      return reply.status(200).send({ orgId: cap.orgId, capUsd: cap.capUsd, period: cap.period });
    },
  );

  server.post(
    '/v1/orgs/:orgId/spend-cap',
    {
      schema: { params: Params, body: Body, response: { 200: CapResponse } },
    },
    async (request, reply) => {
      const params = request.params as ParamsType;
      const body = request.body as BodyType;
      requireNonEmpty({ orgId: params.orgId, userId: body.userId });
      if (typeof body.capUsd !== 'number' || !Number.isFinite(body.capUsd) || body.capUsd < 0) {
        throw new ApiError('client', 'capUsd must be a non-negative number');
      }
      const cap = await setSpendCap(params.orgId, body.capUsd, body.period ?? 'monthly');
      return reply.status(200).send({ orgId: cap.orgId, capUsd: cap.capUsd, period: cap.period });
    },
  );
}
