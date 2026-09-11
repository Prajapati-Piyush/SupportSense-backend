import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { AuthController } from "./auth.controller.js";
import { authenticate } from "../../middleware/auth.js";

export const authRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Public auth endpoints
  app.post("/register", AuthController.register);
  app.post("/login", AuthController.login);
  app.post("/logout", AuthController.logout);

  // Protected endpoint verifying backend session
  app.get(
    "/me",
    {
      preHandler: [authenticate],
    },
    AuthController.me
  );
};

