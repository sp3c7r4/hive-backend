# Phase 1 — Stabilize the Foundation

> 5 tickets. Each ticket = one implementation + one test file.
> Stack: Hono routes → Controller → Service → Repository → Drizzle schema.
> Tests: Vitest with `test` module pattern (no DB mock — hit a test Postgres).

---

## Ticket 1.1 — Fix OAuth Type Errors

**Problem:** `facebook.oauth.service.ts` and `google.oauth.service.ts` have pre-existing TS errors:
- `UserTypes` (old `admin | user`) doesn't index into `getUserMapper()` keys (`instructor | student | parent`)
- Google OAuth `OAuth2Client` type mismatch between `google-auth-library` and `googleapis-common`
- `EmailTemplates` type mismatch on `"welcome"` and `"reset-password"`
- `UserModelMapEntry` doesn't exist (should be `UserModelEntry`)

**What to do:**
1. Align `UserTypes` enum with `UserRole` values or create a mapping
2. Resolve Google OAuth lib version conflict (likely deduplicate `google-auth-library` in `package.json` overrides)
3. Fix `EmailTemplates` type / widen the generic on `EmailQueueService.add()`
4. Fix `UserModelMapEntry` → `UserModelEntry` import in google oauth service

**Test:** TypeScript compilation — `npx tsc --noEmit` exits zero for `src/modules/auth/oauth/**`.

---

## Ticket 1.2 — Add File Upload Routes

**Endpoints:**
```
POST /api/v1/upload/presigned  →  { url, key, bucket }
GET  /api/v1/files/:key/download → { url }
```

**What to build:**
1. `src/modules/upload/upload.controller.ts` — thin controller
2. `src/modules/upload/upload.routes.ts` — mount on `/upload`
3. Zod schemas: `{ contentType: string, filename: string }`
4. Reuse existing `StorageService.generatePresignedUploadUrl` / `generatePresignedDownloadUrl`
5. Auth middleware required on both routes

**Test file:** `tests/upload.test.ts`
- `POST /api/v1/upload/presigned` returns `{ url, key, bucket }` with valid JWT
- `POST /api/v1/upload/presigned` returns 401 without JWT
- `GET /api/v1/files/:key/download` returns `{ url }` with valid JWT

---

## Ticket 1.3 — Complete Payment Controller

**Endpoints:**
```
POST /api/v1/payment/initialize  →  { authorizationUrl, reference }
POST /api/v1/webhook/paystack    →  200 (Paystack IP whitelist validation)
```

**What to build:**
1. Fill in `payment.controller.ts` stubs — `initialize`, `handleWebhook`
2. `initialize`: create pending `payment` row, call `PaystackService.initializeTransaction`, return `authorizationUrl` + `reference`
3. `handleWebhook`: validate Paystack signature header (`x-paystack-signature`), on `charge.success` → set `payment.status = completed`, activate enrollment/community membership, enqueue receipt email
4. Zod schemas for initialize body
5. Add `PAYSTACK_WEBHOOK_SECRET` env var to `EnvSchema`

**Test file:** `tests/payment.test.ts`
- `POST /api/v1/payment/initialize` creates pending payment row and returns authorization URL
- Webhook `charge.success` updates payment status and activates enrollment
- Invalid signature returns 401

---

## Ticket 1.4 — Admin Flag + Email Verified Guard

**Schema change:**
- Add `is_admin: boolean("is_admin").default(false)` to `instructors` table (via `BaseUser` or on the table directly)
- Generate migration

**Middleware:**
1. `requireEmailVerified` — checks `authData.email_verified`, returns 403 if false
2. `requireAdmin` — checks `authData.role === 'instructor' && authData.is_admin`, returns 403 if false
3. Apply `requireEmailVerified` to all protected routes (everything under `/api/v1/*` except auth routes)

**Test file:** `tests/middleware.test.ts`
- Protected route without verified email → 403
- Protected route with verified email → passes
- Admin route without is_admin → 403
- Admin route with is_admin → passes

---

## Ticket 1.5 — Soft-Delete Default Scope

**What to do:**
1. Add optional `includeDeleted` option to `RelationalRepository.findMany`, `findOne`, `findById`
2. Default: `WHERE deleted_at IS NULL` on all queries for tables that have the `deleted_at` column
3. When `includeDeleted: true`, skip the filter
4. Update `PaginateOptions` and `CursorPaginateOptions` to accept `includeDeleted?: boolean`

**Test file:** `tests/soft-delete.test.ts`
- `findAll()` excludes soft-deleted rows by default
- `findAll({ includeDeleted: true })` includes them
- `findById()` on soft-deleted row returns null unless `includeDeleted: true`

---

## Test Infrastructure

All test files go in `tests/` using this pattern:

```ts
// tests/upload.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { testApp } from "./setup"; // Hono app instance

describe("POST /api/v1/upload/presigned", () => {
  it("returns 401 without auth", async () => {
    const res = await testApp.request("/api/v1/upload/presigned", {
      method: "POST",
      body: JSON.stringify({ contentType: "image/png", filename: "test.png" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  });
});
```

`tests/setup.ts` will export a configured Hono `testApp` instance wired to the test database.
