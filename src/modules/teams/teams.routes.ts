import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { authenticate } from "../../middleware/auth.js";
import { query } from "../../db/client.js";

export const teamsRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.addHook("preHandler", authenticate);

  app.get("/", async (req, reply) => {
    const user = req.user!;
    const tenantId = user.tenantId;

    if (!tenantId) {
      reply.status(200).send([]);
      return;
    }

    const res = await query<{
      id: string;
      name: string;
      description: string | null;
      tenant_id: string;
    }>(
      `SELECT id, name, description, tenant_id
       FROM teams
       WHERE tenant_id = $1
       ORDER BY name ASC`,
      [tenantId]
    );

    reply.status(200).send(
      res.rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        tenantId: row.tenant_id,
      }))
    );
  });
};

