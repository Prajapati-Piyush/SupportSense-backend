import Fastify, { FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import { ZodError } from "zod";
import { env } from "./config/env.js";
import { HttpError } from "./utils/errors.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { protectedRoutes } from "./modules/protected/protected.routes.js";
import { customerTicketRoutes } from "./modules/tickets/customer-ticket.routes.js";
import { deskTicketRoutes } from "./modules/tickets/desk-ticket.routes.js";

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: env.NODE_ENV !== "test" ? { level: "info" } : false,
  });

  // Support application/json with empty bodies (e.g. POST /logout)
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body: string, done) => {
    if (!body || body.trim() === "") {
      done(null, {});
      return;
    }
    try {
      const json = JSON.parse(body);
      done(null, json);
    } catch (err: any) {
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  // Cookie plugin
  app.register(fastifyCookie, {
    secret: env.COOKIE_SECRET,
  });

  // CORS plugin (supporting credentials and cookie transport)
  app.register(fastifyCors, {
    origin: (origin, cb) => {
      // Allow requests with no origin (like mobile apps, curl, postman) or configured origin
      if (!origin || origin === env.CORS_ORIGIN) {
        cb(null, true);
        return;
      }
      cb(new Error("Not allowed by CORS"), false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  });

  // Global Error Handler
  app.setErrorHandler((error: any, request, reply) => {
    // 1. Zod Validation Error
    if (error instanceof ZodError) {
      const formattedErrors = error.errors.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      }));
      reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: formattedErrors,
        },
      });
      return;
    }

    // 2. Custom HttpError
    if (error instanceof HttpError) {
      reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      });
      return;
    }

    // 3. Fastify Schema Validation Error
    if (error?.validation) {
      reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: error.message,
        },
      });
      return;
    }

    // 4. Default / Unhandled Error
    request.log.error(error);
    reply.status(error?.statusCode || 500).send({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message:
          env.NODE_ENV === "production"
            ? "An unexpected internal server error occurred."
            : error?.message || "Internal server error",
      },
    });
  });

  // Health check route
  app.get("/health", async () => {
    return {
      status: "ok",
      service: "supportsense-backend",
      timestamp: new Date().toISOString(),
    };
  });

  // Register API modules
  app.register(authRoutes, { prefix: "/api/auth" });
  app.register(protectedRoutes, { prefix: "/api/protected" });
  app.register(customerTicketRoutes, { prefix: "/api/tickets" });
  app.register(deskTicketRoutes, { prefix: "/api/desk/tickets" });

  return app;
}
