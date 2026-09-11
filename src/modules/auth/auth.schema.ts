import { z } from "zod";

export const registerSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(100),
  email: z.string().trim().email("Must be a valid email address"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters"),
  role: z
    .enum(["customer", "staff", "admin", "CUSTOMER", "STAFF", "ADMIN"])
    .optional()
    .transform((val) => (val ? (val.toLowerCase() as "customer" | "staff" | "admin") : "customer")),
  tenantSlug: z.string().optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().trim().email("Must be a valid email address"),
  password: z.string().min(1, "Password is required"),
  tenantSlug: z.string().optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;

