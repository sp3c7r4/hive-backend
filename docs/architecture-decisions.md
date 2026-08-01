# Hive — Architecture Decisions & Implementation Status

> Current-state answers based on the codebase as of the last review.
> Each section notes what's **implemented**, what's **missing**, and what's **unclear**.

---

## 1. Auth

### JWT: httpOnly cookies vs Bearer header?

**Implemented:** Bearer header only. `JwtService.validateToken` extracts `Authorization: Bearer <token>`. There is no httpOnly cookie logic anywhere in the codebase.

**Tokens:** Access + refresh token pair is implemented:
- Access token: RS256 JWT, 30-minute TTL, stored in Redis via `authId` key.
- Refresh token: RS256 JWT with `refreshId` embedded, 7-day TTL, stored in Redis as `refresh:<userId>-<uuid>`.
- `logoutAll` scans Redis with pattern `auth:*` + `refresh:*` to invalidate all sessions.

**Verdict:** Bearer header works for an API. If the frontend is a browser SPA, httpOnly cookies are safer (no JS access to tokens). Consider adding a cookie-based option. The `hive-role` cookie is **not implemented** — nothing in the code sets or reads it. Kill it unless there's a specific use-case (e.g. middleware-level role switching without decoding JWT).

### Unified login lookup

**Implemented:** `AuthService.login()` iterates over `getUserMapper()` (instructor → student → parent) and queries each table's `email` column sequentially. This is a **multi-query loop**, not a single UNION query.

```ts
for (const [role, entry] of Object.entries(mapper)) {
  const user = await entry.repository.findOne(eq(entry.model.email, email));
  if (user) { foundUser = user; foundRole = role; break; }
}
```

**Risk:** Up to 3 sequential DB queries on every login. With only 3 role tables this is acceptable, but if roles grow (admin, moderator, etc.) a UNION ALL view or a single `users` table with a `role` discriminator column would scale better.

### OAuth

**Implemented:** Google and Facebook OAuth routes are wired (`/auth/google`, `/auth/facebook`). Services exist (`google.oauth.service.ts`, `facebook.oauth.service.ts`, `github.oauth.service.ts`). Google and Facebook have env vars configured.

---

## 2. API prefix

**Implemented:** No prefix. Routes are mounted directly:
```
/auth/signup, /auth/login, /auth/refresh, ...
/test/*
/payment/*
/webhook/*
```

**Verdict:** Add `/api/v1/...` or at least `/api/...` before launch. This leaves room for future API versions and separates API routes from potential server-rendered pages or health checks.

### REST-ish or strict REST?

**Implemented:** Pragmatic RPC-style POST endpoints (`/auth/login`, `/auth/refresh`, `/auth/verify-email`). No `GET /users/:id`, no `PATCH /courses/:id`, etc. The test module shows a more RESTful pattern with controller/repository/service layers.

**Verdict:** Go REST-ish. Use `POST` for actions (login, refresh, verify) and `GET/POST/PATCH/DELETE` for resources. Don't obsess over strict HATEOAS.

---

## 3. File uploads

### Storage

**Implemented:** AWS S3 via `@aws-sdk/client-s3`. `StorageService` supports:
- Direct upload (`upload` method — server receives buffer and puts to S3)
- Presigned upload URLs (`generatePresignedUploadUrl` — client uploads directly)
- Presigned download URLs (`generatePresignedDownloadUrl` — for private content)
- Delete and exists checks

Bucket is configured via `AWS_S3_BUCKET` env var. An optional `AWS_S3_ENDPOINT` allows using S3-compatible alternatives (Cloudflare R2, MinIO) via `forcePathStyle: true`.

### URL pattern

**Implemented:** Presigned URLs are the primary mechanism. Public URL would be:
```
https://<bucket>.s3.<region>.amazonaws.com/<key>
```

Keys are generated as `images/<userId>/<fieldName>-<uuid>.<ext>` via `generateImageKey()`.

### Signed URLs for private content

**Implemented:** Yes — `generatePresignedDownloadUrl` with configurable expiry (default 1 hour). Course videos and PDFs should use this. No middleware exists yet to gate access by enrollment status — that needs to be built.

### File size limits

**Not explicitly capped.** The `FileUploadMiddleware` accepts a `sizeLimit` option (in bytes), but no global limits are enforced. Typical sane defaults:

| Type | Recommended Max |
|------|----------------|
| Avatar/image | 5 MB |
| PDF | 50 MB |
| Video | 2 GB (presigned upload) |
| Assignment attachment | 100 MB |

---

## 4. WebSocket scope

### Implemented

The codebase has WebSocket infrastructure:
- `validateWebsocketToken` in `JwtService` handles WS auth via query parameter `?token=...`
- `sendWsSuccessResponse` / `sendWsErrorResponse` helpers exist
- Worker services for Telegram/WhatsApp messaging existed (deleted in refactor) — suggesting prior real-time chat experience

### What's planned vs polling

| Feature | Recommendation | Status |
|---------|---------------|--------|
| **Messaging** — new messages, typing, read receipts | WebSocket | Not implemented |
| **Notifications** — push to client | WebSocket (primary) + polling fallback | Not implemented |
| **Live class** — attendee presence, in-session chat | WebSocket | Not implemented |
| **Quiz** — live results for instructor | WebSocket or Server-Sent Events | Not implemented |
| **Community feed** — new posts/comments | WebSocket optional; polling is fine | Not implemented |

**Verdict:** Build messaging-first. Hono has native WebSocket support. Use a single WS endpoint with a message type discriminator (`{ type: "chat.message" | "notification" | "typing" | ... }`). Polling at 30s intervals is acceptable for community feeds.

---

## 5. Payment provider

### Implemented

**Paystack only.** `PaystackService` extends `PaymentGatewayService` and wraps:
- `POST /transaction/initialize` — returns authorization URL
- `GET /transaction/verify/:reference` — confirms payment status
- Webhook handling — `HandleWebhookOptions` interface exists; `PaystackEvents` enum is defined

The `PaymentGatewayService` base class and `PaymentGatewayFactory` pattern is already set up for adding Flutterwave or other providers later.

### Platform fee

**Schema tracks it server-side:** `payments.platform_fee` is stored as a separate column (default 0, documented as 10%). This is calculated by the server, not by Paystack. Paystack sends the full amount; the server computes `platform_fee = amount * 0.1` before persisting.

### Payment verification

**Implemented:** `verifyTransaction` method in PaystackService. The flow is:
1. Client calls initialize → gets Paystack authorization URL
2. User completes payment on Paystack
3. Paystack redirects to callback URL
4. Server verifies via `GET /transaction/verify/:reference`
5. Paystack also sends webhook as backup confirmation

The webhook route is mounted at `/webhook` — needs Paystack IP whitelist validation.

---

## 6. Email delivery

### Implemented

**AWS SES** via `@aws-sdk/client-sesv2` with `nodemailer` as the transport layer. Handlebars templates are compiled from `src/emails/<template>/html.hbs`. In development mode, emails are rendered as HTML files and opened in the browser instead of sending.

### Transactional emails needed

| Email | Template | Status |
|-------|----------|--------|
| Email verification (OTP) | `verify-otp` | Implemented |
| Welcome email | `welcome` | Implemented |
| Password reset (OTP) | `reset-password` | Implemented |
| Payment receipt | — | **Missing** |
| Community invite | — | **Missing** |
| Course enrollment confirmation | — | **Missing** |
| Certificate issued | — | **Missing** |
| Withdrawal status update | — | **Missing** |

Email is queued via BullMQ (`EmailQueueService`). The worker is in `email.worker.service.ts`.

---

## 7. Search

### Implemented

**Nothing.** There is no search infrastructure in the codebase — no `tsvector`, no `ilike` queries, no Meilisearch/Typesense integration.

### What's needed

Three entity types need searchable fields:

| Entity | Searchable fields |
|--------|------------------|
| Communities | `name`, `description`, `category` |
| Courses | `title`, `subtitle`, `description`, `category` |
| People | `first_name`, `last_name`, `specialization_tags` (instructor), `interest_tags` (student) |

**Recommendation:** Start with PostgreSQL `ilike` + `tsvector` for simplicity. Add a `search_vector` generated column with a GIN index on each searchable table. If performance becomes an issue, Meilisearch is a lightweight upgrade path.

---

## 8. Error format

### Implemented

Response shape is consistent:

```json
// Success
{
  "timestamp": "2025-...",
  "status": 200,
  "success": true,
  "data": { ... }
}

// Error
{
  "timestamp": "2025-...",
  "status": 400,
  "success": false,
  "error": {
    "message": "Email already exists"
  }
}
```

### Validation errors

The Zod engine validates schemas, but field-level error formatting is **not implemented**. Currently, Zod errors likely surface as a raw string. For 400 validation errors, return:

```json
{
  "success": false,
  "error": {
    "message": "Validation failed",
    "errors": [
      { "field": "email", "message": "Invalid email format" },
      { "field": "password", "message": "Must be at least 8 characters" }
    ]
  }
}
```

### Status code map

| Status | Usage |
|--------|-------|
| 200 | Success with data |
| 201 | Resource created |
| 400 | Validation error, bad request |
| 401 | Unauthenticated / invalid token |
| 403 | Forbidden (wrong role) |
| 404 | Resource not found |
| 409 | Conflict (duplicate) |
| 422 | Unprocessable (semantic error, e.g. enrolling in an archived course) |
| 429 | Rate limited |
| 500 | Internal server error |

---

## 9. Rate limiting

### Implemented

**Nothing.** No rate limiter middleware exists.

### What's needed

| Endpoint | Limit |
|----------|-------|
| `POST /auth/login` | 5 per minute per IP (brute-force protection) |
| `POST /auth/signup` | 3 per minute per IP |
| OTP sending (`/auth/forgot-password`, email verify) | 1 per minute per email |
| File upload endpoints | 10 per minute per user |
| `POST /payment/initialize` | 10 per minute per user |

**Recommendation:** Use Hono's built-in rate limiter or a Redis-backed solution. The project already has Redis, so a sliding-window rate limiter is straightforward.

---

## 10. Admin routes

### Implemented

No admin table, no admin flag, no admin middleware. The `user_role` enum has only `instructor`, `student`, `parent`.

### What's needed

The frontend expects these admin routes:
- `/dashboard/admin/*` — admin overview
- `/dashboard/users` — user management
- `/dashboard/logs` — audit logs
- `/dashboard/admin/communities` — community management
- `/dashboard/admin/payments` — payment oversight
- `/dashboard/withdrawals` — withdrawal approval

**Options:**
1. Add an `is_admin` boolean column to `instructors` (simplest; one admin role)
2. Create a separate `admins` table spreading `BaseUser` (cleaner separation; multiple admin roles)
3. Add a `permissions` JSONB column for fine-grained RBAC

**Verdict:** Option 1 for MVP (add `is_admin` boolean to instructors with default `false`). Graduate to option 2 or 3 when admin roles multiply.

---

## 11. Pagination defaults

### Implemented

`PaginationService` supports **both** offset and cursor pagination:

| Method | Default limit | Max limit |
|--------|-------------|-----------|
| `paginate()` (offset) | 10 | 100 |
| `cursorPaginate()` (cursor) | 10 | 100 |

Response includes `{ data, meta: { total, page, limit, totalPages, hasNextPage, hasPrevPage, nextPage, prevPage } }` for offset, and `{ data, meta: { limit, hasNextPage, nextCursor } }` for cursor.

### What to use where

| List | Pagination type |
|------|----------------|
| Messages | Cursor (infinite scroll, avoids duplicates when new messages arrive) |
| Notifications | Cursor |
| Community posts/comments | Cursor |
| Course catalog | Offset (page numbers in UI) |
| Search results | Offset |
| Admin tables | Offset |

---

## 12. Notification delivery

### Implemented

**Nothing.** The notification table exists in schema, but there's no push notification service, no Firebase Cloud Messaging integration, no APNs setup, and no in-app notification delivery mechanism. The `preferences` JSONB on each user has notification settings (`email`, `push`, `marketing`, `digest`) but nothing reads them.

### What's needed

| Channel | Priority |
|---------|----------|
| In-app notifications (polled or WS) | P0 — must have |
| Email digests (daily/weekly summary) | P1 — based on user `digest` preference |
| Push (FCM/APNs) | P2 — can wait |

**Granularity:** The current `preferences.notifications` has:
```ts
{ email: true, push: true, marketing: false, digest: "none" }
```

Add per-type toggles:
```ts
{
  channels: { email: true, push: true },
  types: {
    enrollment: true,
    certificate: true,
    community: true,
    payment: true,
    marketing: false
  },
  digest: "none" | "daily" | "weekly"
}
```

---

## 13. Certificate generation

### Implemented

**Nothing.** The `certificates` table exists with verification fields (`code`, completion/quiz/attendance percents), but there's no PDF generation, no template, and no verification endpoint.

### What's needed

1. **PDF generation:** `pdf-lib` or Puppeteer → render certificate as PDF with student name, course name, completion date, verification code, and a QR code linking to `/verify/<code>`.
2. **Verification endpoint:** `GET /api/verify/:code` → returns certificate metadata (student name, course, issue date). Public, no auth required.
3. **Email:** Send certificate PDF as attachment when issued.

---

## 14. Live class meetings

### Schema says:**
`lessons` table stores `live_meeting_link` (varchar) and `live_meeting_date` (varchar). This is a **manual link** — the instructor pastes a URL.

### OAuth integration

**Planned, not implemented.** The backend will programmatically create Google Meet and Zoom meetings using **Hive's own service accounts** — not per-instructor OAuth. Instructors don't need to link their personal Google/Zoom accounts.

- **Google Meet:** Use a Google Cloud service account with domain-wide delegation for the Calendar API. Hive owns the Google Workspace account; meetings are created under a Hive-owned calendar (e.g. `meetings@hive.com`) and the Meet link is shared with the instructor and students. Requires a Google Cloud service account key + Calendar API enabled.
- **Zoom:** Use Zoom Server-to-Server OAuth (a single Hive Zoom app). Hive's Zoom account creates meetings; the join link is shared. Requires a Zoom Server-to-Server OAuth app with `meeting:write` scope.

**What's needed:**
1. Service account credentials stored as env vars (`GOOGLE_SERVICE_ACCOUNT_KEY`, `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`). No per-instructor token storage.
2. A meeting factory service (`GoogleMeetService`, `ZoomService` implementing a shared `MeetingProvider` interface).
3. On lesson creation with `type = "live"`, the service calls the provider API with the scheduled date/time, creates the meeting, and stores the returned join link in `lessons.live_meeting_link`.
4. Token management is simple: Google service account JWTs are short-lived and auto-generated per API call; Zoom Server-to-Server tokens auto-refresh.

**Schema impact:** `lessons.live_meeting_link` and `lessons.live_meeting_date` are already suitable. Add a `meeting_provider` column (enum: `google_meet` | `zoom`) and a `meeting_id` column to store the provider's internal meeting ID for updates/cancellations. Add env vars to `EnvSchema`.

---

## 15. Video streaming

### Schema says:
`lessons.video_url` (varchar 1000). This implies **external embeds** (YouTube, Vimeo) or **hosted files**.

### Implemented

**Nothing for video.** There's no HLS transcoding, no video upload pipeline, and no streaming infrastructure. The mock UI simulating an upload progress bar was not backed by real upload logic.

**Verdict:** Embed YouTube/Vimeo for MVP. If self-hosting is required later:
- Upload to S3 via presigned URL
- Transcode to HLS with AWS MediaConvert or ffmpeg
- Serve HLS segments via CloudFront with signed URLs
- The `last_position_seconds` column in `lesson_progress` already supports resume playback

---

## 16. Community sequential access + drip content

### Schema has these flags:

| Flag | Table | Purpose |
|------|-------|---------|
| `sequential_courses` | `communities` | Courses must be taken in order |
| `sequential_access` | `courses` | Lessons must be completed in order |
| `drip_content` | `courses` | Lessons unlock on a schedule |

### Enforced?

**Not implemented.** These are database columns only — no middleware or service logic reads them to gate access.

### What's needed

A `ProgressGuard` middleware/service that:
1. Checks `sequential_courses` → user must complete Course N before enrolling in Course N+1 within the community.
2. Checks `sequential_access` → user must complete Lesson N before accessing Lesson N+1 within a course.
3. Checks `drip_content` → a `drip_schedule` column (missing from schema) would define unlock intervals.

The `lesson_progress.completed` flag is already tracked, so the data needed for enforcement exists.

---

## 17. Analytics

### Implemented

**Nothing.** No aggregation queries, no materialized views, no analytics endpoints.

### Counters in schema

| Counter | Table | Updates |
|---------|-------|---------|
| `member_count` | `communities` | Increment/decrement on member join/leave |
| `course_count` | `communities` | Increment/decrement on course create/delete |
| `average_rating`, `review_count` | `communities`, `courses` | Recalculate on review create/update/delete |
| `enrollment_count` | `courses` | Increment on enrollment |

### What's needed

| Dashboard | Metrics | Approach |
|-----------|---------|----------|
| **Parent** | Child attendance %, quiz scores, course progress | Compute on-the-fly from `lesson_progress` + `quiz_attempts` + `assignment_submissions` |
| **Instructor** | Enrollment trends, revenue, course completion rates | Pre-aggregate daily via a cron job into an `analytics_daily` table, or compute on-the-fly with DB queries |
| **Admin** | Platform-wide metrics | Materialized view or admin-only aggregation endpoints |

**Recommendation:** Start with on-the-fly queries (data volumes will be small early on). Add materialized views or a daily aggregation job when dashboards get slow.

---

## 18. Soft deletes

### Implemented

`deleted_at` column is spread via the `softDelete` helper into:
- `communities`
- `courses`
- `enrollments`
- `instructors`, `students`, `parents`
- `messages`
- `parent_child_links`

### Default filtering

**Not implemented.** No repository-level default scope excludes soft-deleted rows. `RelationalRepository` does plain `findOne` / `findAll` with no automatic `WHERE deleted_at IS NULL` filter.

### What's needed

1. Add a default `where: { deleted_at: null }` scope in `RelationalRepository`.
2. Add `includeDeleted` option to override it.
3. Add `GET /...?include_deleted=true` for admin endpoints.

---

## What We Need To Take Note Of (Not Yet Implemented)

### Critical path (must have before launch)

| # | Item | Notes |
|---|------|-------|
| 1 | **Course enrollment flow** | No endpoints exist to enroll a student in a course. `enrollments` table is empty. |
| 2 | **Lesson access & progress** | No endpoints to fetch lessons, mark progress, or resume playback. |
| 3 | **Quiz engine** | Quiz questions are defined, but no endpoint serves questions, accepts answers, or scores attempts. |
| 4 | **Payment completion flow** | `PaystackService` exists, but the controller only has stubs. Webhook verification, enrollment activation on payment success, and receipt generation are all missing. |
| 5 | **Community CRUD** | No controller, routes, or service for communities. |
| 6 | **Course CRUD** | No controller, routes, or service for courses/modules/lessons. |
| 7 | **Messaging** | Schema exists. No WebSocket handler, no REST endpoints, no conversation/message service. |
| 8 | **Notification delivery** | Schema exists. No delivery mechanism (in-app polling, push, or email digest). |
| 9 | **Soft-delete filtering** | `deleted_at` is stored but never filtered in queries. |
| 10 | **Rate limiting** | Zero protection on auth or payment endpoints. |
| 11 | **Email verification guard** | `email_verified` flag exists but no middleware checks it before allowing protected routes. |
| 12 | **API prefix** | `/api/v1/` or `/api/` prefix needed before routes go live. |

### Important (should have soon after)

| # | Item | Notes |
|---|------|-------|
| 13 | **Admin routes & auth** | No admin role. Frontend expects `/dashboard/admin/*`. |
| 14 | **Search** | No search at all — `ilike` or `tsvector` needed for communities, courses, people. |
| 15 | **Certificate generation** | PDF generation + `/verify/:code` endpoint. |
| 16 | **Programmatic meeting creation** | Use Hive's own Google service account + Zoom Server-to-Server OAuth to create meetings. No per-instructor OAuth needed. Needs service account env vars and a `MeetingProvider` abstraction. |
| 17 | **Sequential access + drip enforcement** | Columns exist but no gating logic. |
| 18 | **File size limits** | No max file size enforced. |
| 19 | **Parent dashboard** | No endpoints for parent to view child progress. |
| 20 | **Instructor dashboard** | No enrollment trend or revenue analytics endpoints. |
| 21 | **Review moderation** | No ability to report/flag/hide reviews. |

### Nice to have (post-launch)

| # | Item | Notes |
|---|------|-------|
| 21 | **Video HLS transcoding** | YouTube/Vimeo embeds work for MVP. |
| 22 | **Push notifications (FCM/APNs)** | In-app + email covers most use cases early on. |
| 23 | **Meilisearch/Typesense** | `ilike` + `tsvector` works for reasonable data volumes. |
| 24 | **Materialized analytics views** | On-the-fly queries are fine for early data volumes. |
| 25 | **Multi-provider payments (Flutterwave)** | `PaymentGatewayFactory` pattern is ready for it. |
| 26 | **httpOnly cookie auth option** | Bearer header works; cookies add XSRF protection for browser SPAs. |
| 27 | **OAuth account linking** | Google/Facebook/GitHub OAuth for login exists, but linking an OAuth account to an existing email/password account is not implemented. |

### Design decisions to lock in now

| Decision | Recommendation | Reason |
|----------|---------------|--------|
| API prefix | `/api/v1/` | Versioning from day one avoids migration pain |
| Admin model | `is_admin` boolean on instructors | Simplest; migratable to separate table later |
| Search approach | PostgreSQL `tsvector` + GIN index | Zero new infrastructure; upgrade to Meilisearch if needed |
| Video hosting | YouTube/Vimeo embeds for MVP | Avoids HLS transcoding complexity |
| Pagination for lists | Cursor for messages/notifications/feeds, offset for catalogs | Already implemented in `PaginationService` |
| Error format for validation | `errors` array with `field` + `message` per error | Industry standard; frontend can map errors to form fields |
| WebSocket | Single `/ws` endpoint with type discriminator | Hono natively supports WS; simpler than multiple endpoints |
