# SupportSense Backend Service

Fastify + TypeScript + PostgreSQL backend service for SupportSense, featuring secure session-based authentication using HTTP-only cookies and role-based authorization (`customer`, `staff`, `admin`).

---

## Architecture & Features

- **Framework**: Fastify 5 with TypeScript
- **Database**: PostgreSQL (with connection pooling via `pg`)
- **Password Security**: Bcrypt hashing (`bcryptjs`, 10 rounds)
- **Session Transport**: HTTP-only, `SameSite=Lax` signed cookies (`@fastify/cookie`)
- **Session Management**: PostgreSQL server-side session store with expiration tracking and invalidation
- **Input Validation**: Zod schemas for all request payloads
- **Authorization**: PreHandler middleware (`authenticate`, `requireRole`)
- **CORS**: Configured via `@fastify/cors` with `credentials: true` for cross-origin frontend support

---

## Folder Structure

```
backend/
├── .env.example                     # Sample environment configuration
├── .env                             # Local environment variables
├── .gitignore                       # Git ignore rules
├── package.json                     # Node scripts and dependencies
├── tsconfig.json                    # TypeScript compiler configuration
├── dist/                            # Compiled JavaScript output
├── src/
│   ├── app.ts                       # Fastify application factory & plugin registration
│   ├── index.ts                     # Server entry point & graceful shutdown handlers
│   ├── config/
│   │   └── env.ts                   # Zod-validated environment config
│   ├── db/
│   │   ├── client.ts                # PostgreSQL connection pool and query helpers
│   │   ├── migrate.ts               # Database migration runner
│   │   ├── seed.ts                  # Test user & tenant seed script
│   │   └── migrations/
│   │       └── 001_initial_schema.sql # DDL for tenants, users, and sessions
│   ├── middleware/
│   │   ├── auth.ts                  # authenticate preHandler hook
│   │   └── rbac.ts                  # requireRole preHandler hook factory
│   ├── modules/
│   │   ├── auth/
│   │   │   ├── auth.controller.ts   # register, login, logout, me handlers
│   │   │   ├── auth.routes.ts       # Route definitions under /api/auth
│   │   │   ├── auth.schema.ts       # Zod schemas for request validation
│   │   │   └── auth.service.ts      # Authentication business logic
│   │   ├── protected/
│   │   │   └── protected.routes.ts  # Role-guarded test endpoints (/api/protected)
│   │   └── users/
│   │       ├── user.repository.ts   # Database access methods for users and sessions
│   │       └── user.types.ts        # TypeScript models and interfaces
│   ├── types/
│   │   └── fastify.d.ts             # FastifyRequest augmentation for user & session
│   └── utils/
│       ├── errors.ts                # Custom HTTP error classes
│       └── password.ts              # Password hash & compare helpers
└── test/
    └── auth.test.ts                 # Full integration test suite for auth & RBAC
```

---

## Setup & Installation

### 1. Install Dependencies

```bash
cd backend
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and verify database credentials:

```bash
cp .env.example .env
```

### 3. Run Database Migrations & Seeds

```bash
npm run db:migrate
npm run db:seed
```

### 4. Start Development Server

```bash
npm run dev
```

The backend will start at `http://localhost:4000`.

---

## Test Credentials

All seeded accounts use password: `demo1234`

| Role     | Name          | Email                     | Tenant        |
| -------- | ------------- | ------------------------- | ------------- |
| Customer | Priya Nair    | `priya@example.com`       | Acme Cloud    |
| Staff    | Rahul Verma   | `rahul@acme.test`         | Acme Cloud    |
| Admin    | Meera Iyer    | `meera@acme.test`         | Acme Cloud    |
| Customer | Elena Rostova | `elena@example.com`       | Globex Retail |
| Staff    | Jonas Schmidt | `jonas@globex.test`       | Globex Retail |
| Admin    | Lena Weber    | `lena@globex.test`        | Globex Retail |
| Customer | Customer Demo | `customer@supportsense.local` | Acme Cloud |
| Staff    | Staff Demo    | `staff@supportsense.local`    | Acme Cloud |
| Admin    | Admin Demo    | `admin@supportsense.local`    | Acme Cloud |

---

## API Endpoints

### Auth Endpoints

| Method | Path                | Auth Required | Description                                       |
| ------ | ------------------- | ------------- | ------------------------------------------------- |
| `POST` | `/api/auth/register`| No            | Register new user & set HTTP-only session cookie  |
| `POST` | `/api/auth/login`   | No            | Login user & set HTTP-only session cookie         |
| `POST` | `/api/auth/logout`  | Yes (Cookie)  | Invalidate server session & clear cookie          |
| `GET`  | `/api/auth/me`      | Yes (Cookie)  | Validate cookie & return authenticated user data  |

### Protected Verification Endpoints

| Method | Path                     | Allowed Roles              |
| ------ | ------------------------ | -------------------------- |
| `GET`  | `/api/protected/profile` | `customer`, `staff`, `admin`|
| `GET`  | `/api/protected/staff`   | `staff`, `admin`           |
| `GET`  | `/api/protected/admin`   | `admin`                    |

### Health Check

| Method | Path      | Description         |
| ------ | --------- | ------------------- |
| `GET`  | `/health` | Server health check |

