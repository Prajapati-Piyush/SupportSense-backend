import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/rbac.js";

export const protectedRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Common authentication hook for all routes under this plugin
  app.addHook("preHandler", authenticate);

  // Accessible by any authenticated user (customer, staff, admin)
  app.get("/profile", async (req, reply) => {
    reply.send({
      message: "Access granted to authenticated profile",
      user: req.user,
    });
  });

  // Accessible only by staff or admin
  app.get(
    "/staff",
    {
      preHandler: [requireRole("staff", "admin")],
    },
    async (req, reply) => {
      reply.send({
        message: "Access granted to staff portal area",
        user: req.user,
      });
    }
  );

  // Accessible only by admin
  app.get(
    "/admin",
    {
      preHandler: [requireRole("admin")],
    },
    async (req, reply) => {
      reply.send({
        message: "Access granted to admin console",
        user: req.user,
      });
    }
  );
};

