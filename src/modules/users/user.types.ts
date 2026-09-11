export type UserRole = "customer" | "staff" | "admin";

export interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: UserRole;
  tenant_id: string | null;
  team_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface UserPublic {
  id: string;
  name: string;
  fullName: string;
  email: string;
  role: UserRole;
  tenantId: string | null;
  tenantName: string | null;
  tenantSlug: string | null;
  teamId: string | null;
  teamName: string | null;
  title: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  expires_at: Date;
  created_at: Date;
}

