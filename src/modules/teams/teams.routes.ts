import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { authenticate } from "../../middleware/auth.js";
import { query } from "../../db/client.js";

export const teamsRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.addHook("preHandler", authenticate);

  /**
   * GET /api/teams
   * Lists all teams for the authenticated user's tenant, including members.
   */
  app.get("/", async (req, reply) => {
    const user = req.user!;
    const tenantId = user.tenantId;

    if (!tenantId) {
      reply.status(200).send([]);
      return;
    }

    const teamsRes = await query<{
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

    const membersRes = await query<{
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
       WHERE u.tenant_id = $1 AND u.role IN ('staff', 'admin')
       ORDER BY u.name ASC`,
      [tenantId]
    );

    const membersByTeam = new Map<string, any[]>();
    for (const m of membersRes.rows) {
      if (m.team_id) {
        const list = membersByTeam.get(m.team_id) || [];
        list.push({
          id: m.id,
          tenantId: m.tenant_id,
          tenantName: m.tenant_name || user.tenantName || "Acme Cloud",
          tenantSlug: m.tenant_slug || user.tenantSlug || "acme",
          email: m.email,
          fullName: m.name,
          role: m.role.toUpperCase(),
          teamId: m.team_id,
          teamName: m.team_name,
          title: m.title || null,
          isActive: true,
          createdAt: m.created_at.toISOString(),
        });
        membersByTeam.set(m.team_id, list);
      }
    }

    reply.status(200).send(
      teamsRes.rows.map((row) => {
        const members = (membersByTeam.get(row.id) || []).map((m) => ({
          ...m,
          teamName: row.name,
        }));
        return {
          id: row.id,
          name: row.name,
          description: row.description || "",
          tenantId: row.tenant_id,
          memberIds: members.map((m) => m.id),
          members,
        };
      })
    );
  });

  /**
   * GET /api/teams/:id/members
   * Returns employees assigned to a specific team.
   */
  app.get("/:id/members", async (req: any, reply) => {
    const user = req.user!;
    const tenantId = user.tenantId;
    const { id } = req.params;

    if (!tenantId) {
      reply.status(200).send([]);
      return;
    }

    const membersRes = await query<{
      id: string;
      name: string;
      email: string;
      role: string;
      tenant_id: string;
      team_id: string | null;
      title: string | null;
      created_at: Date;
      team_name: string | null;
    }>(
      `SELECT u.id, u.name, u.email, u.role, u.tenant_id, u.team_id, u.title, u.created_at,
              tm.name as team_name
       FROM users u
       LEFT JOIN teams tm ON u.team_id = tm.id
       WHERE u.tenant_id = $1 AND u.team_id = $2
       ORDER BY u.name ASC`,
      [tenantId, id]
    );

    reply.status(200).send(
      membersRes.rows.map((m) => ({
        id: m.id,
        tenantId: m.tenant_id,
        tenantName: user.tenantName || "Acme Cloud",
        tenantSlug: user.tenantSlug || "acme",
        email: m.email,
        fullName: m.name,
        role: m.role.toUpperCase(),
        teamId: m.team_id,
        teamName: m.team_name,
        title: m.title || null,
        isActive: true,
        createdAt: m.created_at.toISOString(),
      }))
    );
  });
};
