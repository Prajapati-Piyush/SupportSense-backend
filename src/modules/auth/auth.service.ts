import crypto from "crypto";
import { env } from "../../config/env.js";
import { query } from "../../db/client.js";
import { UserRepository } from "../users/user.repository.js";
import { UserPublic } from "../users/user.types.js";
import { hashPassword, verifyPassword } from "../../utils/password.js";
import { ConflictError, NotFoundError, UnauthorizedError } from "../../utils/errors.js";
import { LoginInput, RegisterInput } from "./auth.schema.js";

export interface AuthResult {
  user: UserPublic;
  sessionId: string;
  expiresAt: Date;
}

export class AuthService {
  /**
   * Register a new user and create an active session.
   */
  static async register(input: RegisterInput): Promise<AuthResult> {
    const existing = await UserRepository.findByEmail(input.email);
    if (existing) {
      throw new ConflictError(
        "An account with this email address already exists.",
        "EMAIL_ALREADY_EXISTS"
      );
    }

    let tenantId: string | null = null;
    if (input.tenantSlug) {
      const tenantRes = await query("SELECT id FROM tenants WHERE slug = $1 LIMIT 1", [
        input.tenantSlug.trim(),
      ]);
      if (tenantRes.rows[0]) {
        tenantId = tenantRes.rows[0].id;
      }
    }

    const passwordHash = await hashPassword(input.password);

    const userRow = await UserRepository.create({
      name: input.name,
      email: input.email,
      passwordHash,
      role: input.role,
      tenantId,
    });

    // Create session
    const sessionId = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + env.SESSION_TTL_SECONDS * 1000);
    await UserRepository.createSession(sessionId, userRow.id, expiresAt);

    return {
      user: UserRepository.toPublic(userRow),
      sessionId,
      expiresAt,
    };
  }

  /**
   * Authenticate a user with email + password and issue a session.
   */
  static async login(input: LoginInput): Promise<AuthResult> {
    const userRow = await UserRepository.findByEmail(input.email);
    if (!userRow) {
      throw new UnauthorizedError(
        "Invalid email or password combination.",
        "INVALID_CREDENTIALS"
      );
    }

    const isValid = await verifyPassword(input.password, userRow.password_hash);
    if (!isValid) {
      throw new UnauthorizedError(
        "Invalid email or password combination.",
        "INVALID_CREDENTIALS"
      );
    }

    // Generate secure session ID
    const sessionId = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + env.SESSION_TTL_SECONDS * 1000);
    await UserRepository.createSession(sessionId, userRow.id, expiresAt);

    return {
      user: UserRepository.toPublic(userRow),
      sessionId,
      expiresAt,
    };
  }

  /**
   * Invalidate a session (logout).
   */
  static async logout(sessionId: string): Promise<void> {
    await UserRepository.deleteSession(sessionId);
  }

  /**
   * Get user profile by user ID.
   */
  static async getMe(userId: string): Promise<UserPublic> {
    const userRow = await UserRepository.findById(userId);
    if (!userRow) {
      throw new NotFoundError("User account not found.", "USER_NOT_FOUND");
    }
    return UserRepository.toPublic(userRow);
  }
}

