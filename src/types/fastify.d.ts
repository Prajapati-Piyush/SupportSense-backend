import { UserPublic } from "../modules/users/user.types.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: UserPublic;
    sessionId?: string;
  }
}

