import { query } from "../../db/client.js";
import { UserPublic, UserRow, SessionRow, UserRole } from "./user.types.js";

export interface UserWithTenantRow extends UserRow {
  tenant_name?: string | null;
  tenant_slug?: string | null;
  team_name?: string | null;
}

export class UserRepository {
  /**
   * Find a user by their unique email (case-insensitive) with tenant and team info.
   */
  static async findByEmail(email: string): Promise<UserWithTenantRow | null> {
    const res = await query<UserWithTenantRow>(
      `SELECT u.*, t.name as tenant_name, t.slug as tenant_slug, tm.name as team_name
       FROM users u
       LEFT JOIN tenants t ON u.tenant_id = t.id
       LEFT JOIN teams tm ON u.team_id = tm.id
       WHERE lower(u.email) = lower($1)
       LIMIT 1`,
      [email.trim()]
    );
    return res.rows[0] || null;
  }

  /**
   * Find a user by their UUID with tenant and team info.
   */
  static async findById(id: string): Promise<UserWithTenantRow | null> {
    const res = await query<UserWithTenantRow>(
      `SELECT u.*, t.name as tenant_name, t.slug as tenant_slug, tm.name as team_name
       FROM users u
       LEFT JOIN tenants t ON u.tenant_id = t.id
       LEFT JOIN teams tm ON u.team_id = tm.id
       WHERE u.id = $1
       LIMIT 1`,
      [id]
    );
    return res.rows[0] || null;
  }

  /**
   * Insert a new user into PostgreSQL.
   */
  static async create(data: {
    name: string;
    email: string;
    passwordHash: string;
    role?: UserRole;
    tenantId?: string | null;
  }): Promise<UserRow> {
    const role = data.role ? data.role.toLowerCase() : "customer";
    const res = await query<UserRow>(
      `INSERT INTO users (name, email, password_hash, role, tenant_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [data.name.trim(), data.email.trim().toLowerCase(), data.passwordHash, role, data.tenantId || null]
    );
    return res.rows[0];
  }

  /**
   * Create a new session in PostgreSQL.
   */
  static async createSession(
    sessionId: string,
    userId: string,
    expiresAt: Date
  ): Promise<SessionRow> {
    const res = await query<SessionRow>(
      `INSERT INTO sessions (id, user_id, expires_at)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [sessionId, userId, expiresAt]
    );
    return res.rows[0];
  }

  /**
   * Look up a session by ID if it has not expired.
   */
  static async findActiveSession(sessionId: string): Promise<SessionRow | null> {
    const res = await query<SessionRow>(
      `SELECT * FROM sessions
       WHERE id = $1 AND expires_at > NOW()
       LIMIT 1`,
      [sessionId]
    );
    return res.rows[0] || null;
  }

  /**
   * Delete a session by ID (logout).
   */
  static async deleteSession(sessionId: string): Promise<void> {
    await query("DELETE FROM sessions WHERE id = $1", [sessionId]);
  }

  /**
   * Delete all sessions for a user.
   */
  static async deleteAllUserSessions(userId: string): Promise<void> {
    await query("DELETE FROM sessions WHERE user_id = $1", [userId]);
  }

  /**
   * Map UserRow to a sanitized UserPublic object without sensitive fields.
   */
  static toPublic(user: UserWithTenantRow): UserPublic {
    return {
      id: user.id,
      name: user.name,
      fullName: user.name,
      email: user.email,
      role: user.role,
      tenantId: user.tenant_id || "t-acme",
      tenantName: user.tenant_name || "Acme Cloud",
      tenantSlug: user.tenant_slug || "acme",
      teamId: user.team_id || null,
      teamName: user.team_name || null,
      title: null,
      isActive: true,
      createdAt: user.created_at.toISOString(),
      updatedAt: user.updated_at.toISOString(),
    };
  }
}

