import { FastifyReply, FastifyRequest } from "fastify";
import { UserRepository } from "../modules/users/user.repository.js";
import { UnauthorizedError } from "../utils/errors.js";

export const SESSION_COOKIE_NAME = "session_id";

/**
 * Fastify preHandler hook to enforce session authentication.
 * Never trusts the frontend; strictly checks the HTTP-only cookie against the sessions table.
 */
export async function authenticate(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const sessionId = req.cookies[SESSION_COOKIE_NAME];

  if (!sessionId) {
    throw new UnauthorizedError("Authentication required. No session cookie provided.");
  }

  const session = await UserRepository.findActiveSession(sessionId);
  if (!session) {
    // Clear stale cookie
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    throw new UnauthorizedError("Session has expired or is invalid.", "SESSION_EXPIRED");
  }

  const user = await UserRepository.findById(session.user_id);
  if (!user) {
    await UserRepository.deleteSession(sessionId);
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    throw new UnauthorizedError("User account no longer exists.", "USER_NOT_FOUND");
  }

  // Attach authenticated user and session ID to Fastify request
  req.user = UserRepository.toPublic(user);
  req.sessionId = session.id;
}

