import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/rbac.js";
import { query } from "../../db/client.js";
import { BadRequestError } from "../../utils/errors.js";

export const userRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("staff", "admin"));

  /**
   * GET /api/users
   * Returns users in the caller's tenant with optional filters (role, teamId).
   */
  app.get<{
    Querystring: { role?: string; teamId?: string };
  }>("/", async (req, reply) => {
    const user = req.user!;
    const tenantId = user.tenantId;

    if (!tenantId) {
      throw new BadRequestError("Authenticated user has no associated tenant");
    }

    const conditions: string[] = ["u.tenant_id = $1"];
    const params: any[] = [tenantId];

    if (req.query.role) {
      params.push(req.query.role.toLowerCase());
      conditions.push(`lower(u.role) = $${params.length}`);
    }

    if (req.query.teamId) {
      params.push(req.query.teamId);
      conditions.push(`u.team_id = $${params.length}`);
    }

      const res = await query<{
        id: string;
        name: string;
        email: string;
        role: string;
        tenant_id: string;
        team_id: string | null;
        title: string | null;
        created_at: Date;
        tenant_name: string | null;
        tenant_slug: string | null;
        team_name: string | null;
      }>(
        `SELECT u.id, u.name, u.email, u.role, u.tenant_id, u.team_id, u.title, u.created_at,
                t.name as tenant_name, t.slug as tenant_slug, tm.name as team_name
         FROM users u
         LEFT JOIN teams tm ON u.team_id = tm.id
         LEFT JOIN tenants t ON u.tenant_id = t.id
         WHERE ${conditions.join(" AND ")}
         ORDER BY u.name ASC`,
        params
      );

      reply.status(200).send(
        res.rows.map((u) => ({
          id: u.id,
          tenantId: u.tenant_id,
          tenantName: u.tenant_name || user.tenantName || "Acme Cloud",
          tenantSlug: u.tenant_slug || user.tenantSlug || "acme",
          email: u.email,
          fullName: u.name,
          role: u.role.toUpperCase(),
          teamId: u.team_id,
          teamName: u.team_name,
          title: u.title || null,
          isActive: true,
          createdAt: u.created_at.toISOString(),
        }))
      );
    }
  );
};
