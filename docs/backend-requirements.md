# Hive — Backend Requirements Document

> Generated from full-stack audit of 35 frontend routes against the Drizzle ORM schema.
> All endpoints are prefixed `/api/v1` unless noted. Auth = `Authorization: Bearer <JWT>`.

---

## 1. Auth Endpoints

### POST /api/v1/auth/signup

| Field | Notes |
|---|---|
| Auth | None |
| Body | `{ firstName, lastName, email, password, role }` |
| Response | `201` → `{ user, accessToken, refreshToken }` |
| Side effects | Sends OTP email via BullMQ |

### POST /api/v1/auth/login

| Field | Notes |
|---|---|
| Auth | None |
| Body | `{ email, password }` |
| Response | `200` → `{ user, accessToken, refreshToken }` |
| Logic | Backend loops instructor → student → parent tables; verifies Argon2id hash |

### POST /api/v1/auth/refresh

| Field | Notes |
|---|---|
| Auth | None |
| Body | `{ refreshToken }` |
| Response | `200` → `{ accessToken, refreshToken }` |
| Side effects | Invalidate old refresh token |

### POST /api/v1/auth/verify-email

| Field | Notes |
|---|---|
| Auth | Required |
| Body | `{ otp }` |

### POST /api/v1/auth/forgot-password

| Field | Notes |
|---|---|
| Auth | None |
| Body | `{ email }` |

### POST /api/v1/auth/reset-password

| Field | Notes |
|---|---|
| Auth | Token in body |
| Body | `{ token, password }` |

### POST /api/v1/auth/logout

| Field | Notes |
|---|---|
| Auth | Required |
| Body | `{ refreshToken }` |

### POST /api/v1/auth/logout-all

| Field | Notes |
|---|---|
| Auth | Required |
| Side effects | Invalidates all refresh tokens for user |

### GET/POST /api/v1/auth/google/*

Google OAuth callback — returns same shape as `/auth/login`.

### GET/POST /api/v1/auth/facebook/*

Facebook OAuth callback — returns same shape as `/auth/login`.

---

## 2. File Uploads

### POST /api/v1/upload/presigned

| Field | Notes |
|---|---|
| Auth | Required |
| Body | `{ contentType, filename }` |
| Response | `{ url, key, bucket }` |
| Notes | Client PUTs file directly to `url`. Save `key` to relevant model after upload. |

### GET /api/v1/files/:key/download

| Field | Notes |
|---|---|
| Auth | Required |
| Response | `{ url }` — presigned download URL (1-hour expiry) |
| Notes | For private content only (course videos, PDFs). Public content uses direct S3 URL. |

---

## 3. Dashboard

### 3a. Instructor Dashboard

**GET /api/v1/instructor/stats**

| Query | Type | Notes |
|---|---|---|
| `from` | ISO date | Start of range |
| `to` | ISO date | End of range |

| Response data |
|---|
| `{ totalStudents, totalCourses, totalRevenue, avgRating }` |
| `{ enrollmentTrend: [{ date, count }] }` |
| `{ recentActivity: Activity[] }` |
| `{ actionQueue: Action[] }` — pending assignments to grade, pending member approvals |

**GET /api/v1/instructor/live-classes**

| Query | Type | Notes |
|---|---|---|
| `page` | number | Default 1 |
| `limit` | number | Default 5 |
| `filter` | string | `upcoming` or `past` |

| Response |
|---|
| `data: LiveClass[]` — lessons where `type = 'live'` and course's `instructor_id = authUser.id` |
| `meta: PaginatedResult meta` — offset pagination |

### 3b. Student Dashboard

**GET /api/v1/student/dashboard**

| Response data |
|---|
| `{ streak: number }` |
| `{ continueLearning: Enrollment[] }` — enrolled courses, sorted by `last_accessed` desc, limit 10 |
| `{ recentActivity: Activity[] }` — submissions graded, badges earned, enrollments, class reminders |
| `{ quickStats: { enrolledCourses, completedCourses, certificates, avgScore } }` |

**Activity types**: `submission` (assignment graded), `badge` (certificate issued), `class` (live class starting soon), `feedback` (instructor replied to review), `enrollment` (enrolled in course).

### 3c. Parent Dashboard

**GET /api/v1/parent/dashboard**

| Response data |
|---|
| `{ children: ChildSummary[] }` — via `parent_child_links` |
| `{ pendingRequests: ParentChildLink[] }` — links with `deleted_at IS NULL` where status is pending |

**GET /api/v1/parent/children/:childId/progress**

| Query | Type | Notes |
|---|---|---|
| `from` | ISO date | Optional filter |
| `to` | ISO date | Optional filter |

| Response data |
|---|
| `{ child: { firstName, lastName, avatar } }` |
| `{ attendance: [{ courseId, courseTitle, percent }] }` — based on live class lesson attendance |
| `{ performance: [{ courseId, courseTitle, avgQuizScore }] }` — from `quiz_attempts` aggregate |
| `{ courseProgress: Enrollment[] }` — enrolled courses with `progress_percent` |

### 3d. Admin Dashboard

**GET /api/v1/admin/stats**

| Query | Type | Notes |
|---|---|---|
| `from` | ISO date | Default: 30 days ago |
| `to` | ISO date | Default: now |

| Response data |
|---|
| `{ totalUsers, totalCourses, totalCommunities, totalRevenue }` |
| `{ usersOverTime: [{ date, count }] }` |
| `{ revenueOverTime: [{ date, amount }] }` |
| `{ recentSignups: User[] }` |

---

## 4. Messaging

### Conversations

**GET /api/v1/conversations**

| Query | Type | Notes |
|---|---|---|
| `filter` | string | `all`, `messages` (`type = direct`), or `communities` (`type = group`) |
| `page` | number | Offset pagination |
| `limit` | number | Default 20 |

| Response |
|---|
| `data: Conversation[]` — only conversations where current user is a participant |
| `meta` |

Each `Conversation` includes:
- `id, type, title, lastMessageAt`
- `lastMessage: { content, senderName, createdAt }` (subquery)
- `unreadCount: number` — messages where `read_at IS NULL` and `sender_id != current user`
- `participants: [{ entityId, entityType, firstName, lastName, avatar }]`

**POST /api/v1/conversations**

| Body | Type | Notes |
|---|---|---|
| `type` | `direct \| group` | |
| `participantIds` | `[{entityId, entityType}]` | For direct, exactly 2. For group, 2+. |
| `title` | string | Required for group |

| Side effect | Creates `conversation` + `conversation_participants` rows |

**PATCH /api/v1/conversations/:id**

| Body | Type | Notes |
|---|---|---|
| `pinned` | boolean | Store in a `pinned_by` JSONB or a separate field |
| `muted` | boolean | Store in participant's `muted` field |

**DELETE /api/v1/conversations/:id**

Soft-delete or remove current user as participant (`left_at = now()`).

### Messages

**GET /api/v1/conversations/:id/messages**

| Query | Type | Notes |
|---|---|---|
| `cursor` | string | Cursor-based pagination for infinite scroll |
| `limit` | number | Default 50 |

| Response |
|---|
| `data: Message[]` — sorted by `created_at ASC` (oldest → newest within the cursor window) |
| `meta: { limit, hasNextPage, nextCursor }` |

Message includes:
- `id, type, content, attachmentUrl, createdAt`
- `sender: { entityId, entityType, firstName, lastName, avatar }`
- `readAt` — null or timestamp

**WS → Server: `chat.message`**

```json
{
  "type": "chat.message",
  "payload": {
    "conversationId": 42,
    "type": "text",
    "content": "Hello!",
    "attachmentUrl": null
  }
}
```

Server broadcasts `chat.message` to all participants in that conversation.

**WS → Server: `chat.typing`**

```json
{
  "type": "chat.typing",
  "payload": { "conversationId": 42 }
}
```

Server broadcasts to all other participants (not the sender).

**WS → Server: `chat.read`**

```json
{
  "type": "chat.read",
  "payload": { "conversationId": 42, "messageId": 100 }
}
```

Server updates `messages.read_at = now()` and broadcasts to sender.

### Message Actions

**POST /api/v1/messages/:id/reactions**

| Body | Notes |
|---|---|
| `{ emoji: "👍" }` | Toggle: if exists → remove; else → add. Store in a `reactions` JSONB on messages. |

**DELETE /api/v1/messages/:id**

Only message sender can delete. Soft delete (`deleted_at`). Content becomes "This message was deleted."

---

## 5. Communities

### CRUD

**GET /api/v1/communities**

| Query | Type | Notes |
|---|---|---|
| `page` | number | Default 1 |
| `limit` | number | Default 12 |
| `category` | string | Optional filter |
| `visibility` | string | Default: `public` |
| `search` | string | `ilike` on name, description |

| Response | `data: Community[], meta` |

Used by: `/dashboard/communities`, `/dashboard/explore` (communities tab).

**POST /api/v1/communities**

| Auth | Instructor only |
|---|---|
| Body | `{ name, slug, description, category, visibility, requiresApproval, isPaid, price, coverImageKey }` |

| Used by | `/dashboard/communities/create` |

**GET /api/v1/communities/:slug**

Public detail. Includes `memberCount`, `courseCount`, `averageRating`, `reviewCount`, `instructor` (owner), and a preview of courses (limit 4).

| Used by | `/dashboard/explore/communities/[slug]`, `/dashboard/communities/[slug]/manage` |

**PATCH /api/v1/communities/:slug**

| Auth | Owner or admin |
|---|---|
| Body | Partial update of community fields |

| Used by | Settings tab in manage page |

**DELETE /api/v1/communities/:slug**

| Auth | Owner or admin |
|---|---|
| Side effect | Soft delete. Archive all courses. |

### Members

**GET /api/v1/communities/:slug/members**

| Query | Type | Notes |
|---|---|---|
| `page` | number | |
| `limit` | number | |
| `role` | string | Filter: `owner`, `admin`, `moderator`, `member` |
| `status` | string | Filter: `active`, `inactive`, `banned` |
| `search` | string | Search by name or email |

| Response | `data: CommunityMember[], meta` |

Each member: `{ entityId, entityType, firstName, lastName, email, avatar, role, status, joinedAt }`.

| Used by | Members tab in manage page |

**PATCH /api/v1/communities/:slug/members/:memberId**

| Body | `{ role?, status? }` |
|---|---|
| Auth | Owner or admin |

**DELETE /api/v1/communities/:slug/members/:memberId**

| Auth | Owner or admin |
|---|---|
| Side effect | Remove member (or set status to `inactive`) |

### Invites

**GET /api/v1/communities/:slug/invites**

| Query | Type | Notes |
|---|---|---|
| `page` | number | |
| `limit` | number | |
| `status` | string | `pending`, `accepted`, `expired` |

| Auth | Owner or admin |

**POST /api/v1/communities/:slug/invites**

| Body | `{ emails: string[] }` |
|---|---|
| Auth | Owner or admin |
| Side effects | Creates `community_invites` rows; sends invite emails via BullMQ |

**POST /api/v1/communities/:slug/join**

| Auth | Required |
|---|---|
| Logic | If `requires_approval` → creates member with `status = pending`. If paid → redirect to payment flow. If free & open → creates member with `status = active`. |

**POST /api/v1/communities/:slug/leave**

| Auth | Required |
| Side effect | Sets `community_members.left_at` or deletes row |

### Feed

**GET /api/v1/communities/:slug/feed**

| Query | Type | Notes |
|---|---|---|
| `cursor` | string | Cursor pagination |
| `limit` | number | Default 20 |
| `type` | string | `post`, `announcement` (or `all`) |

| Response | `data: FeedPost[], meta` |

FeedPost:
- `id, type (post|announcement), content, imageKey, createdAt, updatedAt`
- `author: { entityId, entityType, firstName, lastName, avatar }`
- `isPinned: boolean`
- `likes: number`
- `likedByMe: boolean`
- `comments: FeedComment[]` — limit 3, with `totalComments`

FeedComment: `{ id, content, createdAt, author }`

| Notes | This needs a new table: `community_feed_posts` + `community_feed_comments` + `community_feed_likes`. The schema doesn't have these yet. |

**POST /api/v1/communities/:slug/feed**

| Body | `{ type: post|announcement, content, imageKey }` |
|---|---|
| Auth | Community member (admin/moderator for announcements) |

**PATCH /api/v1/communities/:slug/feed/:postId**

| Body | `{ content?, isPinned? }` |
|---|---|
| Auth | Post author or community admin |

**DELETE /api/v1/communities/:slug/feed/:postId**

| Auth | Post author or community admin |

**POST /api/v1/communities/:slug/feed/:postId/like**

Toggle like (auth required). No body.

**POST /api/v1/communities/:slug/feed/:postId/comments**

| Body | `{ content }` |
|---|---|
| Auth | Community member |

**DELETE /api/v1/communities/:slug/feed/:postId/comments/:commentId**

| Auth | Comment author or community admin |

### Analytics

**GET /api/v1/communities/:slug/analytics**

| Query | Type | Notes |
|---|---|---|
| `from` | ISO | |
| `to` | ISO | |

| Response |
|---|
| `{ memberGrowth: [{ date, count }] }` |
| `{ courseEnrollments: [{ courseId, courseTitle, count }] }` |
| `{ activeMembers: number }` — members who accessed content in range |
| `{ revenue: number }` — sum of payments from this community's paid memberships |

| Auth | Owner or admin |
| Used by | Analytics tab in manage page |

---

## 6. Courses

### CRUD

**GET /api/v1/courses**

| Query | Type | Notes |
|---|---|---|
| `page` | number | |
| `limit` | number | |
| `category` | string | |
| `difficulty` | string | `beginner`, `intermediate`, `advanced` |
| `status` | string | Default: `published` (instructor manage page uses `draft,archived` too) |
| `search` | string | `ilike` on title, subtitle |
| `minPrice` | number | kobo |
| `maxPrice` | number | kobo |
| `communityId` | number | Filter by community |

| Response | Course includes: `id, title, slug, subtitle, difficulty, price, isFree, coverImageUrl, enrollmentCount, averageRating, reviewCount, instructor: { firstName, lastName, avatar }` |

| Used by | `/dashboard/courses` (instructor: own courses with `instructor_id` filter), `/dashboard/explore` (courses tab) |

**POST /api/v1/courses**

| Auth | Instructor only |
| Body | `{ communityId, title, slug, subtitle, description, category, difficulty, visibility, price, isFree, monthlyPrice, coverImageKey, sequentialAccess, dripContent, allowComments, allowDownloads, offerCertificate, minCompletionPercent, minQuizScorePercent, minAttendancePercent }` |

| Used by | `/dashboard/courses/create` |

**GET /api/v1/courses/:courseId**

| Response | Full course detail including instructor, community, modules (with lessons), and stats |

| Used by | `/dashboard/explore/courses/[courseId]`, `/dashboard/courses/[courseId]/manage` |

**PATCH /api/v1/courses/:courseId**

| Auth | Instructor (owner) or admin |
| Body | Partial update |

| Used by | Settings tab in manage page |

**DELETE /api/v1/courses/:courseId**

| Auth | Instructor (owner) or admin |
| Side effect | Soft delete. Archive modules/lessons. |

### Curriculum (Modules + Lessons)

**GET /api/v1/courses/:courseId/modules**

Returns modules with nested lessons, sorted by `sort_order`.

| Used by | Curriculum tab, explore course landing page |

**POST /api/v1/courses/:courseId/modules**

| Body | `{ title, description, sortOrder }` |

**PATCH /api/v1/courses/:courseId/modules/:moduleId**

| Body | `{ title?, description?, sortOrder? }` |

**DELETE /api/v1/courses/:courseId/modules/:moduleId**

Cascades to lessons.

**POST /api/v1/courses/:courseId/modules/:moduleId/lessons**

| Body | `{ title, description, type, duration, sortOrder, freePreview, status, videoUrl?, pdfUrl?, liveMeetingDate? }` |

**PATCH /api/v1/courses/:courseId/modules/:moduleId/lessons/:lessonId**

| Body | Partial update |

**DELETE /api/v1/courses/:courseId/modules/:moduleId/lessons/:lessonId**

**PATCH /api/v1/courses/:courseId/modules/reorder**

| Body | `{ order: [{ id, sortOrder }] }` |
| Notes | Called after drag-and-drop. Same pattern for lessons. |

### Live Class Meeting Generation

**POST /api/v1/courses/:courseId/modules/:moduleId/lessons/:lessonId/generate-meeting**

| Body | `{ provider: "google_meet" | "zoom", attendees: [{ entityId, entityType }] }` |
|---|---|
| Auth | Instructor |
| Side effect | Calls Google Calendar API or Zoom API; stores `live_meeting_link` on lesson; sends calendar invite emails to attendees |
| Response | `{ meetingLink, meetingDate }` |

| Used by | Live Class editor drawer — after instructor selects attendees |

### Quiz Builder

**GET /api/v1/lessons/:lessonId/questions**

| Auth | Required |
| Response | `data: QuizQuestion[]` sorted by `sort_order` |

**POST /api/v1/lessons/:lessonId/questions**

| Body | `{ type, text, options, correctAnswer, explanation, points, sortOrder }` |

**PATCH /api/v1/lessons/:lessonId/questions/:questionId**

| Body | Partial update |

**DELETE /api/v1/lessons/:lessonId/questions/:questionId**

### Assignment Builder

**PATCH /api/v1/lessons/:lessonId/assignment-settings**

| Body | `{ instructions, dueDate, maxScore, submissionType, rubric }` |
| Notes | The lesson record (type=assignment) stores these as JSONB or we add a `lesson_settings` JSONB column. If field-level, add dedicated columns. |

### Grading

**GET /api/v1/courses/:courseId/submissions**

| Query | Type | Notes |
|---|---|---|
| `page` | number | |
| `limit` | number | |
| `status` | string | `pending`, `graded` |
| `lessonId` | number | Filter by lesson |

| Auth | Instructor (course owner) |
| Response | `data: AssignmentSubmission[], meta` |
| Notes | Each submission includes student name, lesson title, submitted date, status, score |

**GET /api/v1/submissions/:submissionId**

| Auth | Instructor or submission owner |

**PATCH /api/v1/submissions/:submissionId/grade**

| Body | `{ score, feedback, action: "grade" | "return_for_revision" }` |
|---|---|
| Auth | Instructor |
| Side effects | Updates `score`, `feedback`, `status`, `graded_at`. Sends notification to student. |

---

## 7. Enrollments & Learning

### Enrollment

**POST /api/v1/courses/:courseId/enroll**

| Auth | Student (or Parent enrolling a child) |
|---|---|
| Body | `{ studentId? }` — if parent enrolling child |
| Logic | If free → create enrollment immediately. If paid → return `{ requiresPayment: true, amount }` → client calls `/api/v1/payment/initialize`. |
| Side effect | Increment `courses.enrollment_count` |

**GET /api/v1/student/enrollments**

| Query | Type | Notes |
|---|---|---|
| `page` | number | |
| `limit` | number | |
| `status` | string | `in-progress`, `completed`, `expired` |

| Response | `data: Enrollment[], meta` |
| Notes | Enrollment includes `course` (title, coverImageUrl, instructor, community), `progressPercent`, `lastAccessedAt`, `completedAt`. |

| Used by | `/dashboard/my-courses` |

**GET /api/v1/courses/:courseId/learn**

| Auth | Enrolled student |
| Response | `{ course, modules: [{ ...module, lessons: [{ ...lesson, progress: { completed, lastPositionSeconds } }] }] }` |
| Notes | This is the full learning view. Gated by `sequential_access` and `drip_content` rules. |

| Used by | `/dashboard/courses/[courseId]/learn` |

### Lesson Progress

**POST /api/v1/lessons/:lessonId/progress**

| Body | `{ completed?, lastPositionSeconds? }` |
|---|---|
| Auth | Enrolled student |
| Side effect | Upserts `lesson_progress`. If all lessons in course are completed, calculates `enrollment.progress_percent = 100` and sets `enrollment.completed_at`. Checks certificate thresholds. |

### Quiz Attempts

**POST /api/v1/lessons/:lessonId/quiz/submit**

| Body | `{ answers: [{ questionId, selectedAnswer }] }` |
|---|---|
| Auth | Enrolled student |
| Response | `{ score, total, percent, results: [{ questionId, isCorrect, correctAnswer, explanation }] }` |
| Side effects | Creates `quiz_attempts` rows. Updates `lesson_progress.completed = true`. |

| Used by | Quiz lesson in learning view |

### Assignment Submissions

**POST /api/v1/lessons/:lessonId/assignment/submit**

| Body | `{ text, fileKeys }` |
|---|---|
| Auth | Enrolled student |
| Side effects | Creates `assignment_submission`. Notifies instructor. |

---

## 8. Payments

### POST /api/v1/payment/initialize

| Body | `{ type: "enrollment" | "community", enrollmentId?, communityId?, studentId?, amount }` |
|---|---|
| Auth | Required |
| Logic | Calls Paystack initialize API. Stores pending `payment` row. |
| Response | `{ authorizationUrl, reference }` |

| Used by | Checkout dialog in explore |

### Webhook — POST /api/v1/webhook/paystack

| Auth | Paystack IP whitelist |
| Body | Paystack event payload |
| Logic | Verifies signature. On `charge.success`: set `payment.status = completed`, activate enrollment/community membership, send receipt email, issue certificate if thresholds met. |

### GET /api/v1/payments

| Query | Type | Notes |
|---|---|---|
| `page` | number | |
| `limit` | number | |
| `type` | string | `enrollment`, `community` |
| `status` | string | `success`, `failed`, `pending` |
| `from` | ISO | |
| `to` | ISO | |

| Auth | Required — returns own payments |
| Response | `data: Payment[], meta` |

| Used by | `/dashboard/payments` (History tab) |

### GET /api/v1/payments/subscriptions

| Auth | Required |
| Response | `data: Subscription[]` — community memberships that are paid (`community_members` where community `is_paid = true`). Includes `nextBilling` and `status`. |

| Used by | `/dashboard/payments` (Subscriptions tab) |

---

## 9. Explore & Discover

**GET /api/v1/explore/communities**

| Query | Type | Notes |
|---|---|---|
| `page` | number | |
| `limit` | number | |
| `category` | string | |
| `search` | string | |
| `sort` | string | `popular`, `newest`, `rating` |

**GET /api/v1/explore/courses**

| Query | Type | Notes |
|---|---|---|
| `page` | number | |
| `limit` | number | |
| `category` | string | |
| `difficulty` | string | |
| `price` | string | `free`, `paid`, `all` |
| `search` | string | |
| `sort` | string | `popular`, `newest`, `rating`, `price-low`, `price-high` |

**GET /api/v1/explore/communities/:slug**

Same as `GET /api/v1/communities/:slug` but with additional public-facing fields.

**GET /api/v1/explore/courses/:courseId**

Same as `GET /api/v1/courses/:courseId` but with additional public-facing fields: curriculum preview (first module's lessons), reviews (paginated).

**GET /api/v1/courses/:courseId/reviews**

| Query | Type | Notes |
|---|---|---|
| `page` | number | |
| `limit` | number | |
| `rating` | number | Filter by star count |
| `sort` | string | `newest`, `oldest`, `helpful` |

| Response | `data: Review[], meta` |
| Notes | Review includes student name/avatar, instructor reply (if any). |

---

## 10. Reviews

**POST /api/v1/courses/:courseId/reviews**

| Body | `{ rating: 1-5, title?, comment }` |
|---|---|
| Auth | Enrolled student (completed course or at least 25% progress) |
| Side effect | Updates `courses.average_rating` and `review_count`. |

**PATCH /api/v1/reviews/:reviewId**

| Auth | Review author |

**DELETE /api/v1/reviews/:reviewId**

| Auth | Review author or admin |

**POST /api/v1/reviews/:reviewId/reply**

| Body | `{ comment }` |
|---|---|
| Auth | Instructor (course owner) |
| Side effect | Creates `instructor_reply` |

**POST /api/v1/reviews/:reviewId/helpful**

| Auth | Any authenticated user |
| Logic | Toggle. Adds/removes user ID from `helpful_by_user_ids`. Updates `helpful_count`. |

---

## 11. Search

**GET /api/v1/search**

| Query | Type | Notes |
|---|---|---|
| `q` | string | Search term |
| `type` | string | Comma-separated: `course,community,person` |
| `page` | number | |
| `limit` | number | Default 10 |

| Response |
|---|
| `{ courses: { data, meta }, communities: { data, meta }, people: { data, meta } }` |
| Or flat: `{ data: mixed[], meta }` depending on what the frontend needs. |

| Notes | `ilike` + `tsvector` on indexed columns. Debounce at 300ms client-side. |

| Used by | `/dashboard/search`, global search bar in topbar |

**GET /api/v1/search/quick**

| Query | Type | Notes |
|---|---|---|
| `q` | string | |
| `limit` | number | Default 3 per type |

| Response | `{ courses: Course[], communities: Community[], people: Person[] }` — top `limit` per type |
| Notes | Lightweight endpoint for as-you-type dropdown. No pagination. |

---

## 12. Notifications

**GET /api/v1/notifications**

| Query | Type | Notes |
|---|---|---|
| `cursor` | string | Cursor pagination |
| `limit` | number | Default 20 |
| `type` | string | `submission`, `badge`, `class`, `feedback`, `enrollment`, `payment` |
| `unread` | boolean | Filter: only unread |

| Auth | Required |
| Response | `data: Notification[], meta` |

| Used by | Bell dropdown (last 10, default unread), full drawer |

**PATCH /api/v1/notifications/read-all**

| Auth | Required |
| Side effect | Sets `read_at = now()` on all unread notifications for user |

**PATCH /api/v1/notifications/:id/read**

| Auth | Required |

**WS → Server: `notification`**

Server pushes:
```json
{
  "type": "notification",
  "payload": { "id, type, title, message, createdAt" }
}
```

---

## 13. Certificates

**GET /api/v1/student/certificates**

| Query | Type | Notes |
|---|---|---|
| `page` | number | |
| `limit` | number | |

| Auth | Student |
| Response | `data: Certificate[], meta` |
| Notes | Certificate includes `course` title, `issuedAt`, `code`, `completionPercent`, `quizScorePercent`, `attendancePercent` |

| Used by | `/dashboard/certificates` |

**GET /api/v1/verify/:code**

| Auth | None |
| Response | `{ valid, studentName, courseName, issuedAt, completionPercent, quizScorePercent }` |

| Used by | Public verification page `/verify/[code]` |

**GET /api/v1/certificates/:id/download**

| Auth | Certificate owner |
| Response | PDF binary (generated via `pdf-lib`) |

---

## 14. Instructor Earnings

**GET /api/v1/instructor/earnings**

| Query | Type | Notes |
|---|---|---|
| `page` | number | |
| `limit` | number | |
| `from` | ISO | |
| `to` | ISO | |

| Auth | Instructor |
| Response | `data: Earning[], meta` |
| Notes | Each earning = payment row where `payment.type = 'enrollment'` and course's `instructor_id = authUser.id`. Include `amount, platformFee, netAmount, date, course, student`. |

| Used by | `/dashboard/earnings` |

**GET /api/v1/instructor/earnings/summary**

| Auth | Instructor |
| Response | `{ totalEarnings, totalPlatformFees, netEarnings, pendingWithdrawals, availableBalance }` |

### Withdrawals

**GET /api/v1/instructor/withdrawals**

| Query | Type | Notes |
|---|---|---|
| `page` | number | |
| `limit` | number | |
| `status` | string | |

| Auth | Instructor |
| Used by | `/dashboard/withdrawals` (instructor view) |

**POST /api/v1/instructor/withdrawals**

| Body | `{ amount, bankName, accountNumber, accountName }` |
|---|---|
| Auth | Instructor |
| Side effects | Creates withdrawal row with status `pending`. Deducts from available balance. |

---

## 15. Members (Instructor managing members across all communities)

**GET /api/v1/instructor/members**

| Query | Type | Notes |
|---|---|---|
| `page` | number | |
| `limit` | number | |
| `communityId` | number | Optional filter |
| `search` | string | |
| `status` | string | |

| Auth | Instructor |
| Response | Aggregated across all communities owned by instructor |

| Used by | `/dashboard/members` |

---

## 16. My Communities (Student)

**GET /api/v1/student/communities**

| Query | Type | Notes |
|---|---|---|
| `page` | number | |
| `limit` | number | |

| Auth | Student |
| Response | `data: Community[], meta` — communities where student is a member |

| Used by | `/dashboard/my-communities` |

---

## 17. Settings

**GET /api/v1/me**

| Auth | Required |
| Response | `{ id, firstName, lastName, email, role, avatar, bio, phone, specializationTags?, interestTags?, preferences, onboarded }` |

| Used by | `/dashboard/settings` and for populating sidebar user info |

**PATCH /api/v1/me**

| Auth | Required |
| Body | `{ firstName?, lastName?, avatarKey?, bio?, phone?, preferences?, specializationTags?, interestTags? }` |

**PATCH /api/v1/me/password**

| Body | `{ currentPassword, newPassword }` |
|---|---|
| Auth | Required |

**DELETE /api/v1/me**

| Auth | Required |
| Side effect | Soft delete user account. |

---

## 18. Parent – Child Linking

**POST /api/v1/parent/children**

| Body | `{ studentEmail }` |
|---|---|
| Auth | Parent |
| Side effect | Creates `parent_child_links` row with `status = pending`. Sends email to student for approval. |

**PATCH /api/v1/parent/children/:linkId**

| Body | `{ status: "accepted" | "rejected" }` |
|---|---|
| Auth | Student (the linked child) |

**GET /api/v1/parent/children**

| Auth | Parent |
| Response | `data: ChildSummary[]` — accepted children only |

| Used by | `/dashboard/children` |

---

## 19. Admin Endpoints

All admin endpoints require `role = instructor` + `is_admin = true`.

### Admin Users

**GET /api/v1/admin/users**

| Query | Type | Notes |
|---|---|---|
| `page` | number | |
| `limit` | number | |
| `role` | string | `instructor`, `student`, `parent` |
| `search` | string | |
| `status` | string | `active`, `deleted` |
| `includeDeleted` | boolean | Default false |

| Response | `data: User[], meta` |

| Used by | `/dashboard/users` |

**GET /api/v1/admin/users/:userId**

| Used by | `/dashboard/users/[userId]` |

**PATCH /api/v1/admin/users/:userId**

| Body | `{ role?, status?, isAdmin? }` |

### Admin Communities

**GET /api/v1/admin/communities**

| Query | Type | Notes |
|---|---|---|
| `page` | number | |
| `limit` | number | |
| `search` | string | |
| `includeDeleted` | boolean | |

| Response | `data: Community[], meta` |

| Used by | `/dashboard/admin/communities` |

**PATCH /api/v1/admin/communities/:slug**

Admin can update any community field.

**DELETE /api/v1/admin/communities/:slug**

Hard delete or soft delete.

### Admin Payments

**GET /api/v1/admin/payments**

| Query | Type | Notes |
|---|---|---|
| `page` | number | |
| `limit` | number | |
| `status` | string | |
| `type` | string | |
| `from`, `to` | ISO | |
| `search` | string | Reference or payer name |

| Used by | `/dashboard/admin/payments` |

### Admin Withdrawals

**GET /api/v1/admin/withdrawals**

| Query | Type | Notes |
|---|---|---|
| `page` | number | |
| `limit` | number | |
| `status` | string | `pending`, `processing`, `completed`, `failed` |

| Used by | `/dashboard/withdrawals` (admin view) |

**PATCH /api/v1/admin/withdrawals/:id**

| Body | `{ status, reference? }` |
|---|---|
| Side effect | Process or reject withdrawal. Send email notification. |

### Admin Logs

**GET /api/v1/admin/logs**

| Query | Type | Notes |
|---|---|---|
| `page` | number | |
| `limit` | number | |
| `action` | string | Filter by action type |
| `entityType` | string | `user`, `course`, `community`, `payment` |
| `from`, `to` | ISO | |

| Notes | Needs an `audit_logs` table. Schema doesn't have one yet. |

| Used by | `/dashboard/logs` |

---

## 20. WebSocket Protocol

### Connection

```
ws://host/ws?token=<jwt>
```

Server validates JWT on upgrade. If invalid → close with 4001. If valid → track connection in a connection pool keyed by `(entityId, entityType)`.

### Message Envelope (both directions)

```json
{
  "type": "string",
  "payload": { }
}
```

### Client → Server Types

| Type | Notes |
|---|---|
| `chat.message` | Send a message to a conversation |
| `chat.typing` | User is typing in a conversation |
| `chat.read` | Mark message(s) as read |
| `live.join` | Join a live class room |
| `live.leave` | Leave a live class room |
| `live.chat` | In-session chat message |
| `ping` | Keep-alive |

### Server → Client Types

| Type | Notes |
|---|---|
| `chat.message` | New message received |
| `chat.typing` | Someone is typing |
| `chat.read` | Message was read |
| `notification` | New notification |
| `live.presence` | Attendee joined/left |
| `live.chat` | Chat message in live session |
| `quiz.live_result` | Aggregated quiz results during timed quiz |
| `error` | Error for this client |
| `pong` | Keep-alive response |

### Connection Pool

Server must support the same user connected from multiple tabs/devices. When broadcasting to a conversation, send to all participant connections across all their tabs.

### Fallback

When WebSocket disconnects:
- **Notifications**: Poll `GET /api/v1/notifications?unread=true` every 30s.
- **Messages**: Poll `GET /api/v1/conversations?limit=10` every 30s for unread counts. Full message sync on reconnect via `GET /api/v1/conversations/:id/messages?cursor=lastKnown`.
- **Live class**: Block UI with "Reconnecting..." overlay. No fallback — needs WS.

---

## 21. New Tables Required (not in current schema)

| Table | Reason |
|---|---|
| `community_feed_posts` | Feed on community manage page |
| `community_feed_comments` | Comments on feed posts |
| `community_feed_likes` | Likes on feed posts |
| `audit_logs` | Admin activity logs |
| `conversation_pin_mutes` | Per-participant pin/mute state for conversations |
| `message_reactions` | Emoji reactions on messages (or add JSONB to messages) |

---

## 22. Complete Endpoint Index

```
┌────────┬──────────────────────────────────────────────────────────────┬─────────────────────┐
│ Method │ Path                                                         │ Auth                │
├────────┼──────────────────────────────────────────────────────────────┼─────────────────────┤
│ POST   │ /api/v1/auth/signup                                          │ None                │
│ POST   │ /api/v1/auth/login                                           │ None                │
│ POST   │ /api/v1/auth/refresh                                         │ None                │
│ POST   │ /api/v1/auth/verify-email                                    │ Required            │
│ POST   │ /api/v1/auth/forgot-password                                 │ None                │
│ POST   │ /api/v1/auth/reset-password                                  │ Token               │
│ POST   │ /api/v1/auth/logout                                          │ Required            │
│ POST   │ /api/v1/auth/logout-all                                      │ Required            │
├────────┼──────────────────────────────────────────────────────────────┼─────────────────────┤
│ POST   │ /api/v1/upload/presigned                                     │ Required            │
│ GET    │ /api/v1/files/:key/download                                  │ Required            │
├────────┼──────────────────────────────────────────────────────────────┼─────────────────────┤
│ GET    │ /api/v1/instructor/stats                                     │ Instructor          │
│ GET    │ /api/v1/instructor/live-classes                              │ Instructor          │
│ GET    │ /api/v1/instructor/earnings                                  │ Instructor          │
│ GET    │ /api/v1/instructor/earnings/summary                          │ Instructor          │
│ GET    │ /api/v1/instructor/withdrawals                               │ Instructor          │
│ POST   │ /api/v1/instructor/withdrawals                               │ Instructor          │
│ GET    │ /api/v1/instructor/members                                   │ Instructor          │
├────────┼──────────────────────────────────────────────────────────────┼─────────────────────┤
│ GET    │ /api/v1/student/dashboard                                    │ Student             │
│ GET    │ /api/v1/student/enrollments                                  │ Student             │
│ GET    │ /api/v1/student/communities                                  │ Student             │
│ GET    │ /api/v1/student/certificates                                 │ Student             │
├────────┼──────────────────────────────────────────────────────────────┼─────────────────────┤
│ GET    │ /api/v1/parent/dashboard                                     │ Parent              │
│ GET    │ /api/v1/parent/children                                      │ Parent              │
│ GET    │ /api/v1/parent/children/:childId/progress                    │ Parent              │
│ POST   │ /api/v1/parent/children                                      │ Parent              │
│ PATCH  │ /api/v1/parent/children/:linkId                              │ Student (child)     │
├────────┼──────────────────────────────────────────────────────────────┼─────────────────────┤
│ GET    │ /api/v1/communities                                          │ None (public)       │
│ POST   │ /api/v1/communities                                          │ Instructor          │
│ GET    │ /api/v1/communities/:slug                                    │ None                │
│ PATCH  │ /api/v1/communities/:slug                                    │ Owner/Admin         │
│ DELETE │ /api/v1/communities/:slug                                    │ Owner/Admin         │
│ GET    │ /api/v1/communities/:slug/members                            │ Owner/Admin         │
│ PATCH  │ /api/v1/communities/:slug/members/:memberId                  │ Owner/Admin         │
│ DELETE │ /api/v1/communities/:slug/members/:memberId                  │ Owner/Admin         │
│ GET    │ /api/v1/communities/:slug/invites                            │ Owner/Admin         │
│ POST   │ /api/v1/communities/:slug/invites                            │ Owner/Admin         │
│ POST   │ /api/v1/communities/:slug/join                               │ Required            │
│ POST   │ /api/v1/communities/:slug/leave                              │ Required            │
│ GET    │ /api/v1/communities/:slug/feed                               │ Required            │
│ POST   │ /api/v1/communities/:slug/feed                               │ Member              │
│ PATCH  │ /api/v1/communities/:slug/feed/:postId                       │ Author/Admin        │
│ DELETE │ /api/v1/communities/:slug/feed/:postId                       │ Author/Admin        │
│ POST   │ /api/v1/communities/:slug/feed/:postId/like                  │ Required            │
│ POST   │ /api/v1/communities/:slug/feed/:postId/comments              │ Member              │
│ DELETE │ /api/v1/communities/:slug/feed/:postId/comments/:commentId   │ Author/Admin        │
│ GET    │ /api/v1/communities/:slug/analytics                          │ Owner/Admin         │
├────────┼──────────────────────────────────────────────────────────────┼─────────────────────┤
│ GET    │ /api/v1/courses                                               │ None (public)       │
│ POST   │ /api/v1/courses                                               │ Instructor          │
│ GET    │ /api/v1/courses/:courseId                                     │ None                │
│ PATCH  │ /api/v1/courses/:courseId                                     │ Owner/Admin         │
│ DELETE │ /api/v1/courses/:courseId                                     │ Owner/Admin         │
│ GET    │ /api/v1/courses/:courseId/modules                             │ None                │
│ POST   │ /api/v1/courses/:courseId/modules                             │ Owner               │
│ PATCH  │ /api/v1/courses/:courseId/modules/:moduleId                   │ Owner               │
│ DELETE │ /api/v1/courses/:courseId/modules/:moduleId                   │ Owner               │
│ PATCH  │ /api/v1/courses/:courseId/modules/reorder                     │ Owner               │
│ POST   │ /api/v1/courses/:courseId/modules/:moduleId/lessons           │ Owner               │
│ PATCH  │ /api/v1/courses/:courseId/modules/:moduleId/lessons/:lessonId │ Owner               │
│ DELETE │ /api/v1/courses/:courseId/modules/:moduleId/lessons/:lessonId │ Owner               │
│ POST   │ /.../lessons/:lessonId/generate-meeting                       │ Owner               │
│ POST   │ /api/v1/courses/:courseId/enroll                              │ Student/Parent      │
│ GET    │ /api/v1/courses/:courseId/learn                               │ Enrolled            │
│ GET    │ /api/v1/courses/:courseId/submissions                         │ Owner               │
│ GET    │ /api/v1/courses/:courseId/reviews                             │ None                │
│ POST   │ /api/v1/courses/:courseId/reviews                             │ Enrolled            │
├────────┼──────────────────────────────────────────────────────────────┼─────────────────────┤
│ GET    │ /api/v1/lessons/:lessonId/questions                            │ Required            │
│ POST   │ /api/v1/lessons/:lessonId/questions                            │ Owner               │
│ PATCH  │ /api/v1/lessons/:lessonId/questions/:questionId               │ Owner               │
│ DELETE │ /api/v1/lessons/:lessonId/questions/:questionId               │ Owner               │
│ PATCH  │ /api/v1/lessons/:lessonId/assignment-settings                 │ Owner               │
│ POST   │ /api/v1/lessons/:lessonId/progress                            │ Enrolled            │
│ POST   │ /api/v1/lessons/:lessonId/quiz/submit                         │ Enrolled            │
│ POST   │ /api/v1/lessons/:lessonId/assignment/submit                   │ Enrolled            │
├────────┼──────────────────────────────────────────────────────────────┼─────────────────────┤
│ GET    │ /api/v1/submissions/:submissionId                              │ Owner/Student       │
│ PATCH  │ /api/v1/submissions/:submissionId/grade                        │ Owner               │
├────────┼──────────────────────────────────────────────────────────────┼─────────────────────┤
│ GET    │ /api/v1/conversations                                         │ Required            │
│ POST   │ /api/v1/conversations                                         │ Required            │
│ PATCH  │ /api/v1/conversations/:id                                     │ Participant         │
│ DELETE │ /api/v1/conversations/:id                                     │ Participant         │
│ GET    │ /api/v1/conversations/:id/messages                            │ Participant         │
│ POST   │ /api/v1/messages/:id/reactions                                │ Participant         │
│ DELETE │ /api/v1/messages/:id                                          │ Sender              │
├────────┼──────────────────────────────────────────────────────────────┼─────────────────────┤
│ GET    │ /api/v1/notifications                                         │ Required            │
│ PATCH  │ /api/v1/notifications/read-all                                │ Required            │
│ PATCH  │ /api/v1/notifications/:id/read                                │ Required            │
├────────┼──────────────────────────────────────────────────────────────┼─────────────────────┤
│ POST   │ /api/v1/payment/initialize                                    │ Required            │
│ POST   │ /api/v1/webhook/paystack                                      │ Paystack IP         │
│ GET    │ /api/v1/payments                                              │ Required            │
│ GET    │ /api/v1/payments/subscriptions                                │ Required            │
├────────┼──────────────────────────────────────────────────────────────┼─────────────────────┤
│ GET    │ /api/v1/reviews/:reviewId                                     │ None                │
│ PATCH  │ /api/v1/reviews/:reviewId                                     │ Author              │
│ DELETE │ /api/v1/reviews/:reviewId                                     │ Author/Admin        │
│ POST   │ /api/v1/reviews/:reviewId/reply                               │ Course Instructor   │
│ POST   │ /api/v1/reviews/:reviewId/helpful                             │ Required            │
├────────┼──────────────────────────────────────────────────────────────┼─────────────────────┤
│ GET    │ /api/v1/certificates/:id/download                             │ Owner               │
│ GET    │ /api/v1/verify/:code                                          │ None                │
├────────┼──────────────────────────────────────────────────────────────┼─────────────────────┤
│ GET    │ /api/v1/search                                                │ None                │
│ GET    │ /api/v1/search/quick                                          │ None                │
├────────┼──────────────────────────────────────────────────────────────┼─────────────────────┤
│ GET    │ /api/v1/me                                                    │ Required            │
│ PATCH  │ /api/v1/me                                                    │ Required            │
│ PATCH  │ /api/v1/me/password                                           │ Required            │
│ DELETE │ /api/v1/me                                                    │ Required            │
├────────┼──────────────────────────────────────────────────────────────┼─────────────────────┤
│ GET    │ /api/v1/admin/stats                                           │ Admin               │
│ GET    │ /api/v1/admin/users                                           │ Admin               │
│ GET    │ /api/v1/admin/users/:userId                                   │ Admin               │
│ PATCH  │ /api/v1/admin/users/:userId                                   │ Admin               │
│ GET    │ /api/v1/admin/communities                                     │ Admin               │
│ PATCH  │ /api/v1/admin/communities/:slug                               │ Admin               │
│ DELETE │ /api/v1/admin/communities/:slug                               │ Admin               │
│ GET    │ /api/v1/admin/payments                                        │ Admin               │
│ GET    │ /api/v1/admin/withdrawals                                     │ Admin               │
│ PATCH  │ /api/v1/admin/withdrawals/:id                                 │ Admin               │
│ GET    │ /api/v1/admin/logs                                            │ Admin               │
├────────┼──────────────────────────────────────────────────────────────┼─────────────────────┤
│ GET    │ /api/v1/explore/communities                                   │ None                │
│ GET    │ /api/v1/explore/courses                                       │ None                │
│ GET    │ /api/v1/explore/communities/:slug                             │ None                │
│ GET    │ /api/v1/explore/courses/:courseId                             │ None                │
├────────┼──────────────────────────────────────────────────────────────┼─────────────────────┤
│ WS     │ /ws?token=<jwt>                                               │ JWT on upgrade      │
└────────┴──────────────────────────────────────────────────────────────┴─────────────────────┘
```

**Total: ~90 endpoints + 1 WebSocket**

---

## 23. Pagination Summary

| Endpoint pattern | Pagination type | Default limit |
|---|---|---|
| List endpoints (`/communities`, `/courses`, `/payments`, `/users`, `/members`, `/reviews`, etc.) | Offset (`page`+`limit`) | 10 |
| Feed endpoints (`/communities/:slug/feed`) | Cursor | 20 |
| Message list (`/conversations/:id/messages`) | Cursor | 50 |
| Notification list | Cursor | 20 |
| Search | Offset | 10 |
| Search/quick | N/A (top 3) | 3 |
| Dashboard stats | N/A | — |

All offset-paginated endpoints return the full `PaginatedResult` envelope. All cursor-paginated endpoints return `{ data, meta: { limit, hasNextPage, nextCursor } }`.

---

## 24. WebSocket Summary

| Feature | Transport | Server→Client | Client→Server |
|---|---|---|---|
| **Messaging** | WS | `chat.message`, `chat.typing`, `chat.read` | `chat.message`, `chat.typing`, `chat.read` |
| **Notifications** | WS + polling fallback | `notification` | — |
| **Live class chat/presence** | WS | `live.presence`, `live.chat` | `live.join`, `live.leave`, `live.chat` |
| **Quiz live results** | WS or SSE | `quiz.live_result` | — |
| **Keep-alive** | WS | `pong` | `ping` |
| **Community feed** | Polling (30s) | — | — |
