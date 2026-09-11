import { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../../config/env.js";
import { SESSION_COOKIE_NAME } from "../../middleware/auth.js";
import { AuthService } from "./auth.service.js";
import { loginSchema, registerSchema } from "./auth.schema.js";

function setSessionCookies(
  reply: FastifyReply,
  sessionId: string,
  expiresAt: Date,
  userId?: string,
  role?: string
): void {
  // Primary security boundary: HTTP-only session cookie
  reply.setCookie(SESSION_COOKIE_NAME, sessionId, {
    path: "/",
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    expires: expiresAt,
  });

  // UX / Next.js middleware cookies (readable by frontend server & client)
  if (userId && role) {
    reply.setCookie("ss_uid", userId, {
      path: "/",
      httpOnly: false,
      secure: env.NODE_ENV === "production",
      sameSite: "lax",
      expires: expiresAt,
    });
    reply.setCookie("ss_role", role.toUpperCase(), {
      path: "/",
      httpOnly: false,
      secure: env.NODE_ENV === "production",
      sameSite: "lax",
      expires: expiresAt,
    });
  }
}

function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE_NAME, {
    path: "/",
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
  });
  reply.clearCookie("ss_uid", {
    path: "/",
    httpOnly: false,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
  });
  reply.clearCookie("ss_role", {
    path: "/",
    httpOnly: false,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
  });
}

export class AuthController {
  /**
   * POST /api/auth/register
   * Registers a new user, sets HTTP-only session cookie, returns public user.
   */
  static async register(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const input = registerSchema.parse(req.body);
    const result = await AuthService.register(input);

    setSessionCookies(reply, result.sessionId, result.expiresAt, result.user.id, result.user.role);

    reply.status(201).send({
      message: "User registered successfully",
      user: result.user,
    });
  }

  /**
   * POST /api/auth/login
   * Validates credentials, sets HTTP-only session cookie, returns public user.
   */
  static async login(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const input = loginSchema.parse(req.body);
    const result = await AuthService.login(input);

    setSessionCookies(reply, result.sessionId, result.expiresAt, result.user.id, result.user.role);

    reply.status(200).send({
      message: "Login successful",
      user: result.user,
    });
  }

  /**
   * POST /api/auth/logout
   * Invalidates session on the backend and clears HTTP-only cookie.
   */
  static async logout(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const sessionId = req.cookies[SESSION_COOKIE_NAME];
    if (sessionId) {
      await AuthService.logout(sessionId);
    }

    clearSessionCookies(reply);

    reply.status(200).send({
      message: "Logged out successfully",
    });
  }

  /**
   * GET /api/auth/me
   * Returns current authenticated user validated from the backend session.
   */
  static async me(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    // req.user is populated by the authenticate middleware
    reply.status(200).send({
      user: req.user,
    });
  }
}

