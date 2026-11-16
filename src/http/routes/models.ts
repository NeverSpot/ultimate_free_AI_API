import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

/**
 * GET /v1/models — OpenAI-compatible model discovery.
 *
 * Returns exactly one model id: "free". The gateway picks the actual model
 * at request time (capacity + task-fit routing), so discovery does not
 * enumerate the pool — it advertises the single keyword callers use.
 */

const ModelObject = Type.Object({
  id: Type.String(),
  object: Type.Literal('model'),
  created: Type.Integer(),
  owned_by: Type.String(),
});

const ModelList = Type.Object({
  object: Type.Literal('list'),
  data: Type.Array(ModelObject),
});

type ModelListType = Static<typeof ModelList>;

export function registerModelsRoute(app: FastifyInstance): void {
  const server = app.withTypeProvider<TypeBoxTypeProvider>();

  server.get(
    '/v1/models',
    { schema: { response: { 200: ModelList } } },
    async (_request, reply) => {
      const body: ModelListType = {
        object: 'list',
        data: [
          {
            id: 'free',
            object: 'model',
            created: 0,
            owned_by: 'gateway',
          },
        ],
      };
      return reply.status(200).send(body);
    },
  );
}
