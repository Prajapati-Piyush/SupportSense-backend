import { FastifyReply, FastifyRequest } from "fastify";
import { ForbiddenError, UnauthorizedError } from "../utils/errors.js";
import { UserRole } from "../modules/users/user.types.js";

/**
 * Role-based authorization middleware factory.
 * Enforces that req.user.role belongs to one of the specified allowed roles.
 * Supports case-insensitivity ('staff', 'admin' vs 'STAFF', 'ADMIN').
 */
export function requireRole(...allowedRoles: (UserRole | string)[]) {
  const normalizedAllowed = allowedRoles.map((r) => r.toLowerCase());

  return async function (req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!req.user) {
      throw new UnauthorizedError("Authentication required before role check.");
    }

    const userRole = req.user.role.toLowerCase();

    if (!normalizedAllowed.includes(userRole)) {
      throw new ForbiddenError(
        `Access denied. Requires role: ${allowedRoles.join(" or ")}, but current user has role: ${req.user.role}.`,
        "FORBIDDEN_INSUFFICIENT_ROLE"
      );
    }
  };
}

