# Hive Backend API Specification

> Generated from the feature-complete Hive frontend (Next.js 16, React 19).
> Target stack: Hono + Drizzle ORM + PostgreSQL + Zod + BullMQ + JWT (RS256).
> Every endpoint below is evidenced by actual frontend code — nothing was invented.

---

## 1. Shared Types

```ts
// Standard API envelope for every response
interface ApiResponse<T> {
  timestamp: string;
  status: number;
  success: boolean;
  data: T;
}

// Pagination — mirroring PaginationService.paginate() contract
interface PaginateOptions {
  page?: number;         // default 1
  limit?: number;        // default 20
}

interface PaginatedResult<T> {
  data: T[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
    nextPage: number | null;
    prevPage: number | null;
  };
}
```

---

## 2. TypeScript Entity-Relationship Diagram

```ts
// ── users ──
interface User {
  id: number;
  email: string;                  // unique
  passwordHash: string;
  role: "student" | "instructor" | "parent" | "admin";
  firstName: string;
  lastName: string;
  bio: string | null;
  phone: string | null;
  avatarUrl: string | null;
  specializationTags: string[];   // JSONB, instructor only
  interestTags: string[];         // JSONB, student only
  onboardingCompleted: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
```
> Note: Central identity. One user = one role. Instructors own Courses and Communities. Students and Parents enroll in Courses. Parents link to child Users via ParentChildLink.

```ts
// ── courses ──
interface Course {
  id: number;
  instructorId: number;           // FK → User.id
  communityId: number;            // FK → Community.id
  title: string;
  slug: string;                   // unique
  subtitle: string;
  description: string;
  category: string;
  difficulty: "beginner" | "intermediate" | "advanced";
  visibility: "public" | "private";
  price: number;                  // kobo, 0 = free
  isFree: boolean;
  monthlyPrice: number | null;    // kobo
  coverImageUrl: string | null;
  sequentialAccess: boolean;
  dripContent: boolean;
  allowComments: boolean;
  allowDownloads: boolean;
  offerCertificate: boolean;
  minCompletionPercent: number;
  minQuizScorePercent: number;
  minAttendancePercent: number;
  status: "draft" | "published" | "archived";
  enrollmentCount: number;        // denormalized
  averageRating: number;          // denormalized
  reviewCount: number;            // denormalized
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
```
> Note: Every course must belong to exactly one Community (`communityId` is non-nullable). The frontend create form warns when no community is selected but the backend MUST reject courses with no communityId. Public courses appear on Explore; private courses are only visible to community members. Owned by one Instructor (User).

```ts
// ── modules ──
interface Module {
  id: number;
  courseId: number;               // FK → Course.id
  title: string;
  description: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}
```
> Note: Ordered container for Lessons within a Course. Modules are reorderable via `sortOrder`.

```ts
// ── lessons ──
interface Lesson {
  id: number;
  moduleId: number;               // FK → Module.id
  title: string;
  description: string | null;
  type: "video" | "pdf" | "live" | "quiz" | "assignment";
  duration: string;               // human-readable display string
  sortOrder: number;
  freePreview: boolean;
  status: "draft" | "published";
  videoUrl: string | null;
  pdfUrl: string | null;
  liveMeetingLink: string | null;
  liveMeetingDate: string | null;
  attachmentUrl: string | null;
  createdAt: string;
  updatedAt: string;
}
```
> Note: A Lesson belongs to one Module. Quiz lessons have child QuizQuestions. Assignment lessons have child AssignmentSubmissions. Free preview lessons are visible to non-enrolled students on the course landing page.

```ts
// ── quiz_questions ──
interface QuizQuestion {
  id: number;
  lessonId: number;               // FK → Lesson.id (where type = "quiz")
  type: "multiple" | "truefalse" | "fillblank";
  text: string;
  options: string[] | null;       // JSONB, null for fillblank
  correctAnswer: string;
  explanation: string | null;
  points: number;
  sortOrder: number;
}
```
> Note: Child of a quiz-type Lesson. Multiple questions per quiz, ordered. Student answers stored in QuizAttempt.

```ts
// ── quiz_attempts ──
interface QuizAttempt {
  id: number;
  userId: number;                 // FK → User.id
  lessonId: number;               // FK → Lesson.id
  questionId: number;             // FK → QuizQuestion.id
  selectedAnswer: string | null;
  isCorrect: boolean;
  attemptedAt: string;
}
```
> Note: One record per question per student per attempt. Students can freely navigate between questions; all answers are submitted at once when they press "Submit" on the last question.

```ts
// ── assignment_submissions ──
interface AssignmentSubmission {
  id: number;
  userId: number;                 // FK → User.id
  lessonId: number;               // FK → Lesson.id
  text: string | null;
  fileUrls: string[];             // JSONB
  status: "pending" | "submitted" | "graded" | "returned";
  score: number | null;
  feedback: string | null;
  submittedAt: string | null;
  gradedAt: string | null;
}
```
> Note: One submission per student per assignment lesson. Instructor grades via the course manage Grading tab.

```ts
// ── communities ──
interface Community {
  id: number;
  ownerId: number;                // FK → User.id
  name: string;
  slug: string;                   // unique
  description: string;
  category: string;
  visibility: "public" | "private" | "invite-only";
  requiresApproval: boolean;
  isPaid: boolean;
  price: number | null;           // kobo, null if free
  coverImageUrl: string | null;
  memberCount: number;            // denormalized
  courseCount: number;            // denormalized
  averageRating: number;          // denormalized
  reviewCount: number;            // denormalized
  sequentialCourses: boolean;
  allowDownloads: boolean;
  maxConcurrentDevices: number;
  gracePeriodDays: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
```
> Note: Top-level container for Courses and social interaction. Owned by one User (instructor). Has many CommunityMembers and CommunityInvites. Private/invite-only communities limit visibility; paid communities require subscription.

```ts
// ── community_members ──
interface CommunityMember {
  id: number;
  communityId: number;            // FK → Community.id
  userId: number;                 // FK → User.id
  role: "owner" | "admin" | "member" | "guest";
  status: "active" | "blocked" | "pending";
  joinedAt: string;
  expiresAt: string | null;       // for paid communities
}
```
> Note: Many-to-many pivot between Users and Communities. "pending" means awaiting admin approval (when `requiresApproval` is true). Blocked members lose access. Paid memberships have an expiry date.

```ts
// ── community_invites ──
interface CommunityInvite {
  id: number;
  communityId: number;            // FK → Community.id
  invitedBy: number;              // FK → User.id
  email: string;
  status: "pending" | "accepted" | "expired";
  sentAt: string;
  acceptedAt: string | null;
}
```
> Note: Tracks email invitations sent by community admins. Invite link is `hive.ng/c/:slug/join`. Expired invites are not reusable.

```ts
// ── enrollments ──
interface Enrollment {
  id: number;
  userId: number;                 // FK → User.id (the student taking the course)
  courseId: number;               // FK → Course.id
  enrolledById: number | null;    // FK → User.id (parent who paid, null if self-enrolled)
  progressPercent: number;        // 0-100
  completedAt: string | null;
  expiresAt: string | null;       // for subscription courses
  createdAt: string;
}
```
> Note: Pivot connecting students to courses. `userId` is always the learner. When a parent pays, `enrolledById` records who paid and `userId` is the child. Progress is derived from LessonProgress completion percentage.

```ts
// ── lesson_progress ──
interface LessonProgress {
  id: number;
  enrollmentId: number;           // FK → Enrollment.id
  lessonId: number;               // FK → Lesson.id
  completed: boolean;
  lastPositionSeconds: number;    // for video resume
  completedAt: string | null;
  updatedAt: string;
}
```
> Note: Per-lesson tracking within an enrollment. Video position auto-saves from frontend every 12 seconds via localStorage, synced to server.

```ts
// ── payments ──
interface Payment {
  id: number;
  userId: number;                 // FK → User.id — the payer (who paid)
  enrollmentId: number | null;    // FK → Enrollment.id
  communityId: number | null;     // FK → Community.id (for subscriptions)
  amount: number;                 // kobo
  platformFee: number;            // kobo, 10% of amount
  status: "success" | "failed" | "pending" | "refunded";
  method: string;                 // "Paystack" | "Flutterwave" | "Bank Transfer"
  reference: string;              // payment gateway reference
  type: "enrollment" | "subscription" | "withdrawal";
  description: string;
  studentId: number | null;       // FK → User.id — child beneficiary when parent pays
  receiptUrl: string | null;
  createdAt: string;
}
```
> Note: `userId` is always the payer (person whose card/bank was charged). `studentId` is only populated when a parent pays for a child's course — it identifies the beneficiary, mirroring `Enrollment.enrolledById`. When a student pays for themselves, only `userId` is set and `studentId` is null. Platform fee is always 10% of the amount.

```ts
// ── withdrawals ──
interface Withdrawal {
  id: number;
  instructorId: number;           // FK → User.id
  amount: number;                 // kobo
  bankName: string;
  accountNumber: string;
  accountName: string;
  status: "pending" | "processing" | "completed" | "failed";
  reference: string;
  requestedAt: string;
  processedAt: string | null;
}
```
> Note: Instructor pulls earnings from their available balance. Processed asynchronously via Paystack Transfer API. Status transitions: pending → processing → completed/failed.

```ts
// ── reviews ──
interface Review {
  id: number;
  courseId: number;               // FK → Course.id
  userId: number;                 // FK → User.id
  rating: number;                 // 1-5
  title: string | null;
  comment: string;
  helpfulCount: number;           // denormalized
  helpfulByUserIds: number[];     // JSONB, users who marked helpful
  createdAt: string;
  updatedAt: string;
}
```
> Note: One review per enrollment per course. Has one optional InstructorReply. "Helpful" is a toggle — calling it again unmarks.

```ts
// ── instructor_replies ──
interface InstructorReply {
  id: number;
  reviewId: number;               // FK → Review.id
  instructorId: number;           // FK → User.id
  comment: string;
  createdAt: string;
}
```
> Note: One reply per review, written by the course's instructor.

```ts
// ── certificates ──
interface Certificate {
  id: number;
  userId: number;                 // FK → User.id
  courseId: number;               // FK → Course.id
  enrollmentId: number;           // FK → Enrollment.id
  code: string;                   // unique verification code, publicly accessible
  issuedAt: string;
  completionPercent: number;
  quizScorePercent: number;
  attendancePercent: number;
}
```
> Note: Issued when a student meets all certificate requirements (min completion %, quiz score %, attendance %). Generates a PDF preview. Code is used for public verification at `/verify/:code`.

```ts
// ── messages ──
interface Message {
  id: number;
  conversationId: number;         // FK → Conversation.id
  senderId: number;               // FK → User.id
  text: string | null;
  attachmentType: "image" | "file" | null;
  attachmentName: string | null;
  attachmentSize: string | null;
  attachmentUrl: string | null;
  status: "sent" | "delivered" | "read";
  createdAt: string;
}
```
> Note: Belongs to a Conversation. Supports text, image attachments, and file attachments. Can receive a reaction (emoji code).

```ts
// ── conversations ──
interface Conversation {
  id: number;
  type: "direct" | "community";
  communityId: number | null;     // FK → Community.id (null for direct)
  name: string | null;            // community name or DM participant name
  lastMessagePreview: string;
  lastMessageAt: string;
  createdAt: string;
}
```
> Note: "direct" = 1:1 or small group. "community" = linked to a Community (all members can see). Unread counts and mute/pin state are per-user via ConversationParticipant.

```ts
// ── conversation_participants ──
interface ConversationParticipant {
  id: number;
  conversationId: number;         // FK → Conversation.id
  userId: number;                 // FK → User.id
  pinned: boolean;
  muted: boolean;
  lastReadAt: string;
}
```
> Note: Per-user metadata for each conversation they're in. Unread count is derived: messages after `lastReadAt`.

```ts
// ── posts ──
interface Post {
  id: number;
  communityId: number;            // FK → Community.id
  authorId: number;               // FK → User.id
  content: string;
  type: "post" | "announcement";
  pinned: boolean;
  likesCount: number;             // denormalized
  commentsCount: number;          // denormalized
  createdAt: string;
  updatedAt: string;
}
```
> Note: Community feed item. "announcement" type restricted to community admins. Pinned posts appear at top. Has many PostComments and PostLikes.

```ts
// ── post_likes ──
interface PostLike {
  postId: number;                 // FK → Post.id
  userId: number;                 // FK → User.id
}
```
> Note: Composite primary key (postId, userId), no surrogate id. A user can only like a post once — the PK enforces uniqueness. Toggle behavior: INSERT on first like, DELETE on unlike.

```ts
// ── post_comments ──
interface PostComment {
  id: number;
  postId: number;                 // FK → Post.id
  authorId: number;               // FK → User.id
  content: string;
  createdAt: string;
}
```
> Note: Flat comments (no nesting beyond one level). Author can delete their own; community admin can delete any.

```ts
// ── notifications ──
interface Notification {
  id: number;
  userId: number;                 // FK → User.id
  type: "enrollment" | "submission" | "payment" | "review" | "badge" | "class" | "feedback" | "announcement";
  title: string;
  body: string;
  read: boolean;
  actionUrl: string | null;
  createdAt: string;
}
```
> Note: In-app notification bell (top-bar cluster). Created by the NotificationQueue worker. "read" is toggled when user opens the notification drawer.

```ts
// ── notification_preferences ──
interface NotificationPreference {
  userId: number;                 // PK, FK → User.id
  email: boolean;
  sms: boolean;
  whatsapp: boolean;
  push: boolean;
}
```
> Note: Intentional 1:1 table keyed on userId rather than having a surrogate id — each user has exactly one preference row. Managed via Settings → Notifications and onboarding flow.

```ts
// ── sessions ──
interface Session {
  id: number;
  userId: number;                 // FK → User.id
  device: string;
  ip: string;
  location: string;
  refreshToken: string;
  lastActiveAt: string;
  expiresAt: string;
  createdAt: string;
}
```
> Note: One row per active login session. Refresh token rotation invalidates old sessions. Users can revoke individual sessions or all-but-current.

```ts
// ── parent_child_links ──
interface ParentChildLink {
  id: number;
  parentId: number;               // FK → User.id (role = "parent")
  childId: number;                // FK → User.id (role = "student")
  status: "active" | "pending" | "rejected";
  requestedAt: string;
  approvedAt: string | null;
}
```
> Note: Many-to-many link allowing one parent to monitor multiple children and one child to be linked to multiple parents. Student must approve the link request. Parent can unlink at any time.

```ts
// ── activity_logs ──
interface ActivityLog {
  id: number;
  userId: number | null;          // FK → User.id (nullable for system actions)
  action: string;
  entity: string;
  entityId: number | null;
  metadata: Record<string, unknown>;  // JSONB
  ip: string;
  createdAt: string;
}
```
> Note: Admin-only audit trail. Records all state-changing actions. Metadata stores before/after diffs where relevant. Purged after configurable retention period.

### Relationship Summary

| Relationship | Type | Via |
|---|---|---|
| User → Courses (instructor) | 1:N | Course.instructorId |
| User → Communities (owner) | 1:N | Community.ownerId |
| User ↔ Communities (member) | N:N | CommunityMember |
| User ↔ Courses (student) | N:N | Enrollment |
| Course → Modules | 1:N | Module.courseId |
| Module → Lessons | 1:N | Lesson.moduleId |
| Lesson → QuizQuestions | 1:N | QuizQuestion.lessonId |
| Community → Courses | 1:N | Course.communityId |
| Community → Posts | 1:N | Post.communityId |
| Post → Comments | 1:N | PostComment.postId |
| Post ↔ User (like) | N:N | PostLike (composite PK) |
| Course → Reviews | 1:N | Review.courseId |
| Review → InstructorReply | 1:1 | InstructorReply.reviewId |
| Enrollment → LessonProgress | 1:N | LessonProgress.enrollmentId |
| Parent ↔ Child | N:N | ParentChildLink |
| User → Conversations | N:N | ConversationParticipant |
| Conversation → Messages | 1:N | Message.conversationId |
| User → Payments | 1:N | Payment.userId |
| User → Withdrawals | 1:N | Withdrawal.instructorId |
| User → NotificationPreference | 1:1 | NotificationPreference.userId (PK) |

---

## 3. API Endpoints

### 3.1 Auth

#### Register (initiate signup)
| | |
|---|---|
| Trigger | SignUpForm component |
| Auth | Public |
| Method & Route | POST /api/v1/auth/register |

```ts
interface RegisterRequest {
  role: "student" | "instructor" | "parent";
  firstName: string;
  lastName: string;
  email: string;
  password: string;
}
```
Validation: role ∈ ["student","instructor","parent"], firstName min 2 chars, lastName min 2 chars, email valid format, password min 8 chars.

```ts
interface RegisterResponse {
  data: { message: string; expiresInSeconds: number };
}
```
> Note: Creates an unverified user record, generates 6-digit OTP, enqueues send-otp-email job. No JWT issued yet. Frontend navigates to OTP verification screen. OTP expires after 60 seconds.

Error cases: 409 email already registered (any role).

#### Verify OTP
| | |
|---|---|
| Trigger | VerifyOTPForm component |
| Auth | Public |
| Method & Route | POST /api/v1/auth/verify-otp |

```ts
interface VerifyOtpRequest {
  email: string;
  otp: string;
  source: "signup" | "forgot-password";
}
```
Validation: email required, otp required (string, exactly 6 digits).

```ts
interface VerifyOtpResponse {
  data: {
    accessToken: string;      // JWT RS256, expires 15min
    refreshToken: string;     // opaque, expires 7d (30d if remember=true)
    user: {
      id: number;
      email: string;
      role: "student" | "instructor" | "parent" | "admin";
      firstName: string;
      lastName: string;
      onboardingCompleted: boolean;
    };
  };
}
```
> Note: For `source: "signup"`, marks user as verified, issues JWT pair, enqueues send-welcome-email. For `source: "forgot-password"`, returns a temporary `resetToken` (not a JWT) — the user must then call reset-password.

Error cases: 400 invalid OTP, 400 OTP expired, 404 email not found.

#### Login
| | |
|---|---|
| Trigger | LoginForm component |
| Auth | Public |
| Method & Route | POST /api/v1/auth/login |

```ts
interface LoginRequest {
  email: string;
  password: string;
  role: "student" | "instructor" | "parent" | "admin";
  remember: boolean;
}
```
Validation: email required, password required, role ∈ valid roles.

```ts
interface LoginResponse {
  data: {
    accessToken: string;
    refreshToken: string;
    user: {
      id: number;
      email: string;
      role: "student" | "instructor" | "parent" | "admin";
      firstName: string;
      lastName: string;
      onboardingCompleted: boolean;
    };
  };
}
```
> Note: When `remember` is true, refresh token expires in 30 days instead of 7. Frontend sets `hive-role` cookie + localStorage on success.

Error cases: 401 invalid credentials, 403 role mismatch (user exists with different role).

#### Refresh Token
| | |
|---|---|
| Trigger | Automatic on 401 responses (middleware) |
| Auth | Public (refresh token in body) |
| Method & Route | POST /api/v1/auth/refresh |

```ts
interface RefreshRequest {
  refreshToken: string;
}
```
```ts
interface RefreshResponse {
  data: { accessToken: string; refreshToken: string; };
}
```
> Note: Rotates refresh token — old token invalidated, new one issued. If old token is expired/revoked, returns 401.

Error cases: 401 expired/revoked token.

#### Forgot Password
| | |
|---|---|
| Trigger | ForgotPasswordForm component |
| Auth | Public |
| Method & Route | POST /api/v1/auth/forgot-password |

```ts
interface ForgotPasswordRequest {
  email: string;
  role: "student" | "instructor" | "parent";
}
```
Validation: email required, valid format. Role must be a valid non-admin role.

```ts
interface ForgotPasswordResponse {
  data: { message: string; expiresInSeconds: number };
}
```
> Note: Always returns 200 regardless of whether the email exists (prevents user enumeration). If found, generates OTP and enqueues send-otp-email with `source: "forgot-password"`.

Error cases: none (always 200).

#### Reset Password
| | |
|---|---|
| Trigger | ResetPasswordForm component |
| Auth | Reset token (from verify-otp with forgot-password source) |
| Method & Route | POST /api/v1/auth/reset-password |

```ts
interface ResetPasswordRequest {
  resetToken: string;
  password: string;
}
```
Validation: resetToken required, password min 8 chars.

```ts
interface ResetPasswordResponse {
  data: { message: string };
}
```
> Note: Invalidates all existing sessions for the user. Enqueues send-password-reset-confirmation email. Frontend navigates to login with success banner.

Error cases: 400 token expired/invalid, 422 password too weak.

#### Logout
| | |
|---|---|
| Trigger | Sidebar logout button |
| Auth | Authenticated |
| Method & Route | POST /api/v1/auth/logout |

```ts
interface LogoutResponse {
  data: { message: string };
}
```
> Note: Invalidates the current refresh token. Other sessions remain active (user can revoke them from Settings).

#### Google OAuth
| | |
|---|---|
| Trigger | SocialButtons "Continue with Google" |
| Auth | Public |
| Route | GET /api/v1/auth/google → redirect → GET /api/v1/auth/google/callback |

```ts
interface OAuthCallbackResponse {
  data: {
    accessToken: string;
    refreshToken: string;
    user: { id: number; email: string; role: string; firstName: string; lastName: string; onboardingCompleted: boolean; };
    isNewUser: boolean;
  };
}
```
> Note: On first login, creates unverified user with role unset — frontend prompts role selection. Returns same shape as LoginResponse.

#### Apple OAuth
| | |
|---|---|
| Trigger | SocialButtons "Continue with Apple" |
| Auth | Public |
| Route | GET /api/v1/auth/apple → redirect → GET /api/v1/auth/apple/callback |
> Note: Same flow and response shape as Google OAuth.

---

### 3.2 Users

#### Get current user
| | |
|---|---|
| Trigger | Dashboard layout hydration |
| Auth | Authenticated |
| Method & Route | GET /api/v1/users/me |

```ts
interface GetMeResponse {
  data: {
    id: number;
    email: string;
    role: "student" | "instructor" | "parent" | "admin";
    firstName: string;
    lastName: string;
    bio: string | null;
    phone: string | null;
    avatarUrl: string | null;
    specializationTags: string[];
    interestTags: string[];
    onboardingCompleted: boolean;
    createdAt: string;
  };
}
```

#### Update profile
| | |
|---|---|
| Trigger | Settings → Profile section "Save changes" button |
| Auth | Authenticated |
| Method & Route | PATCH /api/v1/users/me |

```ts
interface UpdateProfileRequest {
  firstName?: string;
  lastName?: string;
  bio?: string;
  phone?: string;
}
```
Validation: firstName min 2 chars if provided, lastName min 2 chars if provided, phone optional Nigerian format.

```ts
interface UpdateProfileResponse {
  data: { id: number; firstName: string; lastName: string; bio: string | null; phone: string | null; };
}
```
Error cases: 422 invalid phone format.

#### Upload avatar
| | |
|---|---|
| Trigger | Settings → "Add photo" / "Change photo" button → file input |
| Auth | Authenticated |
| Method & Route | POST /api/v1/users/me/avatar |
| Content-Type | multipart/form-data |

```ts
interface UploadAvatarRequest {
  file: File;   // multipart field "file", max 5MB, image/* mime types only
}
```
Validation: file required, mime ∈ ["image/jpeg","image/png","image/webp","image/gif"], max 5MB.

```ts
interface UploadAvatarResponse {
  data: { avatarUrl: string; };
}
```
> Note: Old avatar is NOT deleted (keep for audit). Returns signed URL to uploaded file.

Error cases: 413 file too large, 422 invalid mime type, 401 unauthenticated.

#### Change password
| | |
|---|---|
| Trigger | Settings → Security "Update password" button |
| Auth | Authenticated |
| Method & Route | POST /api/v1/users/me/password |

```ts
interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}
```
Validation: currentPassword required, newPassword min 8 chars, newPassword !== currentPassword.

```ts
interface ChangePasswordResponse {
  data: { message: string };
}
```
Error cases: 403 current password incorrect, 422 new password too weak.

#### Delete account
| | |
|---|---|
| Trigger | Settings → Danger zone → "Delete my account" button + confirmation dialog |
| Auth | Authenticated |
| Method & Route | POST /api/v1/users/me/delete |

```ts
interface DeleteAccountRequest {
  confirmation: string;   // must exactly equal "delete my account"
}
```

```ts
interface DeleteAccountResponse {
  data: { message: string; recoverableUntil: string; };
}
```
> Note: Soft-delete — sets deletedAt. Data retained 30 days per Nigerian data protection regulation. User can recover by contacting support within that window. All refresh tokens invalidated immediately.

Error cases: 422 confirmation text mismatch.

#### Complete onboarding
| | |
|---|---|
| Trigger | Onboarding page → final step |
| Auth | Authenticated (onboardingCompleted = false) |
| Method & Route | POST /api/v1/users/me/onboarding |

```ts
interface CompleteOnboardingRequest {
  avatarUrl?: string;
  bio?: string;                        // instructor only
  specializationTags?: string[];       // instructor only
  interestTags?: string[];             // student only
  notifications: {
    email: boolean;
    sms: boolean;
    whatsapp: boolean;
    push: boolean;
  };
}
```
> Note: Creates or updates NotificationPreference row. Sets onboardingCompleted = true. Frontend redirects to dashboard on success.

```ts
interface CompleteOnboardingResponse {
  data: { onboardingCompleted: true; };
}
```

#### Update notification preferences
| | |
|---|---|
| Trigger | Settings → Notifications "Save preferences" button |
| Auth | Authenticated |
| Method & Route | PATCH /api/v1/users/me/notifications |

```ts
interface UpdateNotificationPreferencesRequest {
  email: boolean;
  sms: boolean;
  whatsapp: boolean;
  push: boolean;
}
```

#### List active sessions
| | |
|---|---|
| Trigger | Settings → Security → Active sessions list |
| Auth | Authenticated |
| Method & Route | GET /api/v1/users/me/sessions |

```ts
interface GetSessionsResponse {
  data: {
    id: number;
    device: string;
    ip: string;
    location: string;
    lastActiveAt: string;
    current: boolean;     // true for the session making this request
  }[];
}
```

#### Revoke session
| | |
|---|---|
| Trigger | Settings → Security → "Revoke" button per session |
| Auth | Authenticated |
| Method & Route | DELETE /api/v1/users/me/sessions/:sessionId |
> Note: Cannot revoke the current session. Returns 422 if attempted.

#### Revoke all other sessions
| | |
|---|---|
| Trigger | Settings → Security → "Revoke all other sessions" button |
| Auth | Authenticated |
| Method & Route | POST /api/v1/users/me/sessions/revoke-all |
> Note: Invalidates all refresh tokens except the current one.

---

### 3.3 Parent-Student Linking

#### Search student by email
| | |
|---|---|
| Trigger | LinkedAccounts → search input |
| Auth | Authenticated (parent role only) |
| Method & Route | GET /api/v1/parent/children/search?email=:email |

```ts
interface SearchChildRequest {
  email: string;    // query param, required
}
```

```ts
interface SearchChildResponse {
  data: {
    id: number;
    firstName: string;
    lastName: string;
    email: string;
    avatarUrl: string | null;
    alreadyLinked: boolean;
  } | null;     // null if no student found
}
```
> Note: Only searches users with role="student". Returns null for non-existent or non-student emails. `alreadyLinked` is true if there's an existing active ParentChildLink.

Error cases: 403 non-parent role.

#### Send link request
| | |
|---|---|
| Trigger | LinkedAccounts → "Send Request" button after searching |
| Auth | Authenticated (parent role only) |
| Method & Route | POST /api/v1/parent/children/link |

```ts
interface LinkChildRequest {
  childId: number;
}
```
Validation: childId required, must be a user with role="student", must not already have an active link to this parent.

```ts
interface LinkChildResponse {
  data: { linkId: number; status: "pending"; };
}
```
> Note: Creates a ParentChildLink with status="pending". The child sees this in their LinkedAccounts and can approve/reject. A notification is sent to the child.

Error cases: 403 non-parent, 404 child not found, 409 already linked.

#### List linked children
| | |
|---|---|
| Trigger | LinkedAccounts → linked children list; `/dashboard/children` page |
| Auth | Authenticated (parent role only) |
| Method & Route | GET /api/v1/parent/children |

```ts
interface GetChildrenResponse {
  data: {
    id: number;
    firstName: string;
    lastName: string;
    email: string;
    avatarUrl: string | null;
    status: "active" | "pending" | "rejected";
    enrolledCourseCount: number;
    linkedAt: string;
  }[];
}
```
> Note: Returns all links regardless of status. Parent dashboard filters to active only internally.

#### List pending link requests (student side)
| | |
|---|---|
| Trigger | LinkedAccounts → pending requests list |
| Auth | Authenticated (student role only) |
| Method & Route | GET /api/v1/students/parent-requests |

```ts
interface GetParentRequestsResponse {
  data: {
    linkId: number;
    parent: { id: number; firstName: string; lastName: string; email: string; };
    requestedAt: string;
  }[];
}
```

#### Approve/reject link request (student side)
| | |
|---|---|
| Trigger | LinkedAccounts → "Approve" / "Reject" buttons |
| Auth | Authenticated (student role only) |
| Method & Route | POST /api/v1/students/parent-requests/:linkId/respond |

```ts
interface RespondToLinkRequest {
  action: "approve" | "reject";
}
```
Validation: action ∈ ["approve","reject"]. Link must belong to the requesting student and be in "pending" status.

```ts
interface RespondToLinkResponse {
  data: { linkId: number; status: "active" | "rejected"; };
}
```
> Note: On approve, status becomes "active" and the parent can view the child's progress. On reject, the parent sees "rejected" but can re-request.

Error cases: 403 not the target student, 404 link not found, 409 link already responded to.

#### Unlink child
| | |
|---|---|
| Trigger | LinkedAccounts → "Unlink" button |
| Auth | Authenticated (parent role only) |
| Method & Route | DELETE /api/v1/parent/children/:childId |
> Note: Permanently removes the link. Parent can re-request later. Child is not notified of unlinking.

#### Get child detail (progress view)
| | |
|---|---|
| Trigger | `/dashboard/children/[childId]` page |
| Auth | Authenticated (parent, must have active link to this child) |
| Method & Route | GET /api/v1/parent/children/:childId |

```ts
interface GetChildDetailResponse {
  data: {
    id: number;
    firstName: string;
    lastName: string;
    email: string;
    avatarUrl: string | null;
    enrollments: {
      id: number;
      course: { id: number; title: string; slug: string; category: string; };
      progressPercent: number;
      lastAccessedAt: string;
      completed: boolean;
    }[];
    recentActivity: {
      type: string;
      text: string;
      time: string;
    }[];
    certificates: {
      id: number;
      courseTitle: string;
      code: string;
      issuedAt: string;
    }[];
  };
}
```
> Note: Aggregated view. recentActivity is derived from child's LessonProgress, QuizAttempts, and AssignmentSubmissions. Parent dashboard uses this for the "My Children" overview.

Error cases: 403 not the parent of this child, 404 child not found.

---

### 3.4 Courses (Instructor Management)

#### List instructor's courses
| | |
|---|---|
| Trigger | `/dashboard/courses` page |
| Auth | Authenticated (instructor role only) |
| Method & Route | GET /api/v1/courses |

```ts
interface ListMyCoursesRequest {
  page?: number;
  limit?: number;
  filter?: {
    status?: "draft" | "published" | "archived";
    category?: string;
  };
}
```

```ts
type ListMyCoursesResponse = ApiResponse<PaginatedResult<{
  id: number;
  title: string;
  slug: string;
  category: string;
  difficulty: string;
  status: "draft" | "published" | "archived";
  enrollmentCount: number;
  averageRating: number;
  coverImageUrl: string | null;
  price: number;
  isFree: boolean;
  communityName: string;
}>>;
```

#### Create course
| | |
|---|---|
| Trigger | `/dashboard/courses/create` → "Publish" or "Save Draft" button |
| Auth | Authenticated (instructor role only) |
| Method & Route | POST /api/v1/courses |
| Content-Type | multipart/form-data (when cover image included) |

```ts
interface CreateCourseRequest {
  title: string;
  description: string;
  category: string;
  difficulty: "beginner" | "intermediate" | "advanced";
  communityId: number;
  visibility: "public" | "private";
  isFree: boolean;
  oneTimePrice?: number;         // kobo, required if !isFree
  monthlyPrice?: number;         // kobo, optional
  sequentialAccess: boolean;
  dripContent: boolean;
  allowComments: boolean;
  allowDownloads: boolean;
  offerCertificate: boolean;
  minCompletionPercent: number;
  minQuizScorePercent: number;
  minAttendancePercent: number;
  coverImage?: File;             // multipart field, optional
}
```
Validation: title required (max 120 chars), description required (max 800 chars), category required, communityId required (must be a community owned or admin'd by this instructor), oneTimePrice required if !isFree, percentages 0-100.

```ts
interface CreateCourseResponse {
  data: { id: number; slug: string; };
}
```
> Note: Creates course with status="published" (if "Publish") or status="draft" (if "Save Draft"). Slug is auto-generated from title. Community membership check: instructor must be owner or admin of the target community.

Error cases: 403 not community owner/admin, 422 missing required fields, 422 invalid communityId.

#### Get course detail (manage view)
| | |
|---|---|
| Trigger | `/dashboard/courses/[courseId]/manage` page |
| Auth | Authenticated (course owner only) |
| Method & Route | GET /api/v1/courses/:courseId |

```ts
interface GetCourseManageResponse {
  data: {
    id: number;
    title: string;
    slug: string;
    description: string;
    category: string;
    difficulty: string;
    visibility: "public" | "private";
    isFree: boolean;
    oneTimePrice: number | null;
    monthlyPrice: number | null;
    coverImageUrl: string | null;
    sequentialAccess: boolean;
    dripContent: boolean;
    allowComments: boolean;
    allowDownloads: boolean;
    offerCertificate: boolean;
    minCompletionPercent: number;
    minQuizScorePercent: number;
    minAttendancePercent: number;
    status: string;
    enrollmentCount: number;
    communityId: number;
    communityName: string;
    modules: {
      id: number;
      title: string;
      description: string | null;
      sortOrder: number;
      lessons: {
        id: number;
        title: string;
        description: string | null;
        type: string;
        duration: string;
        sortOrder: number;
        freePreview: boolean;
        status: "draft" | "published";
        hasAttachment: boolean;
      }[];
    }[];
  };
}
```

#### Update course settings
| | |
|---|---|
| Trigger | Course manage → Settings tab → "Save & Publish" or "Save Draft" button |
| Auth | Authenticated (course owner only) |
| Method & Route | PATCH /api/v1/courses/:courseId |

```ts
interface UpdateCourseRequest {
  title?: string;
  description?: string;
  category?: string;
  difficulty?: "beginner" | "intermediate" | "advanced";
  visibility?: "public" | "private";
  isFree?: boolean;
  oneTimePrice?: number | null;
  monthlyPrice?: number | null;
  sequentialAccess?: boolean;
  dripContent?: boolean;
  allowComments?: boolean;
  allowDownloads?: boolean;
  offerCertificate?: boolean;
  minCompletionPercent?: number;
  minQuizScorePercent?: number;
  minAttendancePercent?: number;
  status?: "draft" | "published";
}
```
Validation: same field-level rules as CreateCourse, all fields optional (partial update).

Error cases: 403 not course owner, 404 course not found.

#### Upload course cover image
| | |
|---|---|
| Trigger | Course manage → Settings → cover image upload |
| Auth | Authenticated (course owner only) |
| Method & Route | POST /api/v1/courses/:courseId/cover |
| Content-Type | multipart/form-data |

```ts
interface UploadCoverRequest {
  file: File;   // max 10MB, image/*
}
```
```ts
interface UploadCoverResponse {
  data: { coverImageUrl: string; };
}
```
Error cases: 413 too large, 422 invalid mime.

#### Publish course
| | |
|---|---|
| Trigger | Course manage → Settings → "Confirm & Publish" in checklist dialog |
| Auth | Authenticated (course owner only) |
| Method & Route | POST /api/v1/courses/:courseId/publish |

```ts
interface PublishCourseResponse {
  data: { status: "published"; warnings: string[]; };
}
```
> Note: Validates readiness: all non-draft lessons, at least one module, cover image present. Warnings are returned for non-blocking issues (e.g., "1 lesson still in draft — won't be visible").

Error cases: 403 not owner, 422 no publishable lessons.

#### Archive course
| | |
|---|---|
| Trigger | Course manage → Settings → Danger zone → "Archive Course" button |
| Auth | Authenticated (course owner only) |
| Method & Route | POST /api/v1/courses/:courseId/archive |

```ts
interface ArchiveCourseResponse {
  data: { status: "archived"; };
}
```
> Note: Existing students retain access. New enrollments are blocked. Can be restored from settings.

#### Create module
| | |
|---|---|
| Trigger | Course manage → Curriculum tab → "Add Module" |
| Auth | Authenticated (course owner only) |
| Method & Route | POST /api/v1/courses/:courseId/modules |

```ts
interface CreateModuleRequest {
  title: string;
}
```
Validation: title required, max 150 chars.

```ts
interface CreateModuleResponse {
  data: { id: number; sortOrder: number; };
}
```

#### Reorder modules
| | |
|---|---|
| Auth | Authenticated (course owner only) |
| Method & Route | PATCH /api/v1/courses/:courseId/modules/reorder |

```ts
interface ReorderModulesRequest {
  order: number[];   // array of all module IDs in desired order
}
```

#### Update module
| | |
|---|---|
| Method & Route | PATCH /api/v1/courses/:courseId/modules/:moduleId |

```ts
interface UpdateModuleRequest {
  title?: string;
  description?: string | null;
}
```

#### Delete module
| | |
|---|---|
| Method & Route | DELETE /api/v1/courses/:courseId/modules/:moduleId |
> Note: Cascade deletes all lessons in the module. Cannot be undone.

#### Create lesson
| | |
|---|---|
| Trigger | Curriculum tab → "Add Lesson" within a module |
| Auth | Authenticated (course owner only) |
| Method & Route | POST /api/v1/courses/:courseId/modules/:moduleId/lessons |

```ts
interface CreateLessonRequest {
  title: string;
  description?: string;
  type: "video" | "pdf" | "live" | "quiz" | "assignment";
  duration: string;
  freePreview: boolean;
}
```
Validation: title required, type ∈ valid lesson types, duration required.

```ts
interface CreateLessonResponse {
  data: { id: number; sortOrder: number; };
}
```

#### Update lesson
| | |
|---|---|
| Method & Route | PATCH /api/v1/courses/:courseId/modules/:moduleId/lessons/:lessonId |

```ts
interface UpdateLessonRequest {
  title?: string;
  description?: string | null;
  type?: "video" | "pdf" | "live" | "quiz" | "assignment";
  duration?: string;
  freePreview?: boolean;
  status?: "draft" | "published";
  videoUrl?: string | null;
  pdfUrl?: string | null;
  liveMeetingLink?: string | null;
  liveMeetingDate?: string | null;
}
```

#### Upload lesson attachment
| | |
|---|---|
| Method & Route | POST /api/v1/courses/:courseId/modules/:moduleId/lessons/:lessonId/attachment |
| Content-Type | multipart/form-data |

```ts
interface UploadAttachmentRequest {
  file: File;   // any file type, max 100MB
}
```
```ts
interface UploadAttachmentResponse {
  data: { attachmentUrl: string; attachmentName: string; attachmentSize: string; };
}
```

#### Delete lesson
| | |
|---|---|
| Method & Route | DELETE /api/v1/courses/:courseId/modules/:moduleId/lessons/:lessonId |

#### Reorder lessons
| | |
|---|---|
| Method & Route | PATCH /api/v1/courses/:courseId/modules/:moduleId/lessons/reorder |

```ts
interface ReorderLessonsRequest {
  order: number[];   // array of lesson IDs in new order
}
```

#### Quiz question management
| | |
|---|---|
| Auth | Authenticated (course owner only) |

Routes:
- GET /api/v1/courses/:courseId/modules/:moduleId/lessons/:lessonId/questions — list
- POST /api/v1/courses/:courseId/modules/:moduleId/lessons/:lessonId/questions — create
- PATCH /api/v1/courses/:courseId/modules/:moduleId/lessons/:lessonId/questions/:questionId — update
- DELETE /api/v1/courses/:courseId/modules/:moduleId/lessons/:lessonId/questions/:questionId — delete

```ts
interface CreateQuizQuestionRequest {
  type: "multiple" | "truefalse" | "fillblank";
  text: string;
  options?: string[];         // required for multiple, null otherwise
  correctAnswer: string;
  explanation?: string;
  points: number;
}

interface UpdateQuizQuestionRequest {
  type?: "multiple" | "truefalse" | "fillblank";
  text?: string;
  options?: string[] | null;
  correctAnswer?: string;
  explanation?: string | null;
  points?: number;
}

interface GetQuizQuestionsResponse {
  data: {
    id: number;
    type: string;
    text: string;
    options: string[] | null;
    correctAnswer: string;
    explanation: string | null;
    points: number;
    sortOrder: number;
  }[];
}
```

#### Assignment submissions (grading)
| | |
|---|---|
| Auth | Authenticated (course owner only) |

Routes:
- GET /api/v1/courses/:courseId/assignments/:lessonId/submissions — list submissions
- PATCH /api/v1/courses/:courseId/assignments/:lessonId/submissions/:submissionId/grade — grade

```ts
interface GetSubmissionsResponse {
  data: {
    id: number;
    student: { id: number; name: string; initials: string; };
    status: "pending" | "submitted" | "graded" | "returned";
    text: string | null;
    fileUrls: string[];
    score: number | null;
    submittedAt: string | null;
  }[];
}

interface GradeSubmissionRequest {
  score: number;
  feedback?: string;
}
```
Validation: score required, 0-100.

---

### 3.5 Explore & Discovery

#### Browse public courses
| | |
|---|---|
| Trigger | `/dashboard/explore` page, Courses tab |
| Auth | Authenticated (any role) |
| Method & Route | GET /api/v1/explore/courses |

```ts
interface BrowseCoursesRequest {
  page?: number;
  limit?: number;
  filter?: {
    category?: string;
    difficulty?: "beginner" | "intermediate" | "advanced";
    price?: "Free" | "Paid";
    search?: string;
  };
}
```

```ts
type BrowseCoursesResponse = ApiResponse<PaginatedResult<{
  id: number;
  title: string;
  slug: string;
  category: string;
  difficulty: string;
  rating: number;
  reviewCount: number;
  price: number;
  isFree: boolean;
  instructor: { id: number; name: string; initials: string; };
  enrollmentCount: number;
  subtitle: string;
  certificate: boolean;
  communitySlug: string;
  communityName: string;
}>>;
```
> Note: Only returns courses with visibility="public" AND status="published". Private courses are excluded regardless of filter.

#### Browse communities
| | |
|---|---|
| Trigger | `/dashboard/explore` page, Communities tab |
| Auth | Authenticated (any role) |
| Method & Route | GET /api/v1/explore/communities |

```ts
interface BrowseCommunitiesRequest {
  page?: number;
  limit?: number;
  filter?: {
    category?: string;
    price?: "Free" | "Paid";
    search?: string;
  };
}
```

```ts
type BrowseCommunitiesResponse = ApiResponse<PaginatedResult<{
  id: number;
  name: string;
  slug: string;
  category: string;
  visibility: string;
  memberCount: number;
  courseCount: number;
  rating: number;
  description: string;
  price: number | null;
}>>;
```

#### Get course landing page
| | |
|---|---|
| Trigger | `/dashboard/explore/courses/[courseId]` |
| Auth | Authenticated (any role) |
| Method & Route | GET /api/v1/explore/courses/:slug |

```ts
interface GetCourseLandingResponse {
  data: {
    id: number;
    title: string;
    slug: string;
    subtitle: string;
    category: string;
    difficulty: string;
    rating: number;
    reviewCount: number;
    price: number;
    isFree: boolean;
    instructor: { id: number; name: string; initials: string; bio: string; rank: string; };
    enrollmentCount: number;
    certificate: boolean;
    certRequirements: { completionPercent: number; quizScorePercent: number; attendancePercent: number; };
    visibility: "public" | "private";
    communityId: number;
    communityName: string;
    communitySlug: string;
    enrolled: boolean;
    completed: boolean;
    isCommunityMember: boolean;
    curriculum: {
      title: string;
      lessons: {
        title: string;
        type: string;
        duration: string;
        freePreview: boolean;
      }[];
    }[];
  };
}
```
> Note: `enrolled`, `completed`, and `isCommunityMember` are computed per requesting user. If private and not a community member, the frontend shows a gate banner and "Join & Enroll" flow instead of direct enrollment. Course includes its reviews via a separate endpoint (see Reviews section).

Error cases: 404 slug not found.

#### Get community landing page
| | |
|---|---|
| Trigger | `/dashboard/explore/communities/[slug]` |
| Auth | Authenticated (any role) |
| Method & Route | GET /api/v1/explore/communities/:slug |

```ts
interface GetCommunityLandingResponse {
  data: {
    id: number;
    name: string;
    slug: string;
    category: string;
    visibility: string;
    description: string;
    memberCount: number;
    courseCount: number;
    rating: number;
    reviewCount: number;
    instructor: { id: number; name: string; initials: string; bio: string; specialties: string[]; };
    price: number | null;
    isFree: boolean;
    requiresApproval: boolean;
    isMember: boolean;
    isOwner: boolean;
    courses: {
      id: number;
      slug: string;
      title: string;
      difficulty: string;
      price: number;
      isFree: boolean;
    }[];
  };
}
```
Error cases: 404 slug not found.

---

### 3.6 Enrollments & Learning

#### Enroll in a course
| | |
|---|---|
| Trigger | Course landing → "Enroll for Free" / "Proceed to Payment" / "Join & Enroll" |
| Auth | Authenticated (student or parent role) |
| Method & Route | POST /api/v1/enrollments |

```ts
interface EnrollRequest {
  courseId: number;
  paymentReference?: string;    // required for paid courses
  childId?: number;             // only when parent enrolls for a child
}
```
Validation: courseId required, paymentReference required if course is paid and not already purchased, childId must be a linked active child of the requesting parent.

```ts
interface EnrollResponse {
  data: {
    enrollmentId: number;
    courseSlug: string;
    communityJoined: boolean;
    accessGranted: boolean;
  };
}
```
> Note: For private courses, checks community membership. If not a member and community is free/public, auto-joins the community (sets `communityJoined: true`). If paid/invite-only community, returns 402 with community info. For paid courses, verifies payment reference before creating enrollment.

Error cases: 402 payment required, 403 community membership required, 409 already enrolled.

#### Get enrolled course (learning view)
| | |
|---|---|
| Trigger | `/dashboard/courses/[courseId]/learn` page |
| Auth | Authenticated (enrolled student, or parent of enrolled child) |
| Method & Route | GET /api/v1/enrollments/:courseId/learn |

```ts
interface GetLearnViewResponse {
  data: {
    enrollmentId: number;
    course: { id: number; title: string; slug: string; instructor: { name: string; initials: string; }; };
    progressPercent: number;
    modules: {
      id: number;
      title: string;
      lessons: {
        id: number;
        title: string;
        type: string;
        duration: string;
        completed: boolean;
        lastPositionSeconds: number;
      }[];
    }[];
    quizAttempts: {
      lessonId: number;
      questionId: number;
      selectedAnswer: string | null;
      isCorrect: boolean;
    }[];
    assignmentSubmissions: {
      lessonId: number;
      status: string;
      score: number | null;
      feedback: string | null;
    }[];
    nextLesson: { moduleIndex: number; lessonIndex: number; } | null;
    completed: boolean;
    certificateEarned: boolean;
    certificateCode: string | null;
  };
}
```

#### Update lesson progress
| | |
|---|---|
| Trigger | VideoPlayer → auto-save every 12 seconds (batched from localStorage) |
| Auth | Authenticated (enrolled student) |
| Method & Route | POST /api/v1/enrollments/:courseId/lessons/:lessonId/progress |

```ts
interface UpdateProgressRequest {
  lastPositionSeconds: number;
  completed: boolean;
}
```
> Note: Called at most once per 12s per active video. Frontend throttles to avoid overwhelming the server. Also called on lesson complete (video ended, quiz submitted, assignment submitted).

#### Submit quiz
| | |
|---|---|
| Trigger | QuizLesson → "Submit" button (on last question) |
| Auth | Authenticated (enrolled student) |
| Method & Route | POST /api/v1/enrollments/:courseId/lessons/:lessonId/quiz |

```ts
interface SubmitQuizRequest {
  answers: { questionId: number; answer: string; }[];
}
```

```ts
interface SubmitQuizResponse {
  data: {
    score: number;
    totalPoints: number;
    percentCorrect: number;
    answers: { questionId: number; correct: boolean; correctAnswer: string; }[];
  };
}
```
> Note: Submits all answers at once. Backend grades each answer, creates QuizAttempt records. Returns per-question results for the review screen.

#### Submit assignment
| | |
|---|---|
| Trigger | AssignmentLesson → submit form |
| Auth | Authenticated (enrolled student) |
| Method & Route | POST /api/v1/enrollments/:courseId/lessons/:lessonId/assignment |
| Content-Type | multipart/form-data |

```ts
interface SubmitAssignmentRequest {
  text?: string;
  files?: File[];    // multipart, optional
}
```

```ts
interface SubmitAssignmentResponse {
  data: { submissionId: number; status: "submitted"; };
}
```

#### Get course completion status
| | |
|---|---|
| Auth | Authenticated (enrolled student) |
| Method & Route | GET /api/v1/enrollments/:courseId/completion |

```ts
interface GetCompletionResponse {
  data: {
    completed: boolean;
    progressPercent: number;
    quizScorePercent: number;
    attendancePercent: number;
    certificateEarned: boolean;
    completionDate: string | null;
  };
}
```

---

### 3.7 Reviews

#### List course reviews
| | |
|---|---|
| Trigger | Course landing page → reviews section |
| Auth | Authenticated (any role) |
| Method & Route | GET /api/v1/courses/:courseId/reviews |

```ts
interface ListReviewsRequest {
  page?: number;
  limit?: number;
  filter?: { sort?: "recent" | "helpful" | "highest" | "lowest"; };
}
```

```ts
type ListReviewsResponse = ApiResponse<PaginatedResult<{
  id: number;
  author: { id: number; name: string; initials: string; };
  rating: number;
  title: string | null;
  comment: string;
  helpfulCount: number;
  markedHelpful: boolean;       // by current user
  instructorReply: { comment: string; createdAt: string; } | null;
  createdAt: string;
}>>;
```

#### Submit review
| | |
|---|---|
| Trigger | ReviewForm → submit |
| Auth | Authenticated (enrolled student only, not already reviewed) |
| Method & Route | POST /api/v1/courses/:courseId/reviews |

```ts
interface CreateReviewRequest {
  rating: number;       // 1-5
  title?: string;
  comment: string;
}
```
Validation: rating ∈ [1,2,3,4,5], comment required min 10 chars.

```ts
interface CreateReviewResponse {
  data: { id: number; };
}
```
Error cases: 403 not enrolled, 409 already reviewed.

#### Mark review as helpful
| | |
|---|---|
| Auth | Authenticated |
| Method & Route | POST /api/v1/courses/:courseId/reviews/:reviewId/helpful |

```ts
interface MarkHelpfulResponse {
  data: { helpfulCount: number; markedHelpful: boolean; };
}
```
> Note: Toggle — calling again removes the mark. One mark per user per review.

#### Reply to review (instructor)
| | |
|---|---|
| Trigger | Course manage → review reply |
| Auth | Authenticated (course owner only) |
| Method & Route | POST /api/v1/courses/:courseId/reviews/:reviewId/reply |

```ts
interface ReplyToReviewRequest {
  comment: string;
}
```
> Note: Creates or updates the InstructorReply. Only one reply per review.

---

### 3.8 Payments

#### Get payment history
| | |
|---|---|
| Trigger | `/dashboard/payments` → History tab |
| Auth | Authenticated |
| Method & Route | GET /api/v1/payments |

```ts
interface ListPaymentsRequest {
  page?: number;
  limit?: number;
}
```

```ts
type ListPaymentsResponse = ApiResponse<PaginatedResult<{
  id: number;
  date: string;
  description: string;
  amount: number;
  amountDisplay: string;     // formatted "₦XX,XXX"
  studentName?: string;      // only for parent
  status: "success" | "failed" | "pending";
  method: string;
  receiptUrl: string | null;
}>>;
```
> Note: For parent role, returns payments for all linked children (via `studentId`). For student/instructor, returns own payments. For admin, returns all.

#### Get subscriptions
| | |
|---|---|
| Trigger | `/dashboard/payments` → Subscriptions tab |
| Auth | Authenticated |
| Method & Route | GET /api/v1/payments/subscriptions |

```ts
interface GetSubscriptionsResponse {
  data: {
    id: number;
    name: string;
    amount: number;
    amountDisplay: string;
    cycle: string;
    nextBillingDate: string;
    status: "active" | "past_due" | "cancelled";
    graceDaysRemaining: number;
  }[];
}
```

#### Initiate payment
| | |
|---|---|
| Trigger | Checkout dialog → "Pay Now" button |
| Auth | Authenticated |
| Method & Route | POST /api/v1/payments/initialize |

```ts
interface InitializePaymentRequest {
  courseId: number;
  childId?: number;           // for parent paying for child
  referralCode?: string;
}
```
Validation: courseId required and must exist, childId must be a linked active child.

```ts
interface InitializePaymentResponse {
  data: {
    authorizationUrl: string;    // Paystack checkout URL
    reference: string;
    accessCode: string;
  };
}
```
> Note: Creates a Payment record with status="pending". The frontend opens the Paystack inline popup using the SDK. The authorizationUrl is NOT a redirect — it's used by Paystack's JS popup.

Error cases: 404 course not found, 403 child not linked.

#### Verify payment (webhook)
| | |
|---|---|
| Trigger | Paystack webhook (server-to-server); also callback from Paystack popup |
| Auth | Paystack IP whitelist (webhook); Authenticated (callback) |
| Method & Route | POST /api/v1/payments/verify |

```ts
interface VerifyPaymentRequest {
  reference: string;
}
```

```ts
interface VerifyPaymentResponse {
  data: {
    status: "success" | "failed";
    enrollmentId?: number;
    courseSlug?: string;
  };
}
```
> Note: On success, finalizes Payment (status="success"), creates Enrollment, enqueues send-payment-receipt email. Platform fee (10%) is calculated and stored. Frontend redirects to `/dashboard/payments?success=1&ref=:reference`.

Error cases: 404 reference not found, 409 already verified.

#### Download receipt
| | |
|---|---|
| Auth | Authenticated (payment owner or admin) |
| Method & Route | GET /api/v1/payments/:id/receipt |
> Note: Returns PDF binary or generates and returns. Cached after first generation.

---

### 3.9 Withdrawals

#### Get withdrawal summary
| | |
|---|---|
| Trigger | `/dashboard/earnings` → stat cards |
| Auth | Authenticated (instructor role only) |
| Method & Route | GET /api/v1/withdrawals/summary |

```ts
interface WithdrawalSummaryResponse {
  data: {
    totalEarnings: number;            // kobo, all-time
    thisMonthEarnings: number;        // kobo
    availableForWithdrawal: number;   // kobo, after 10% fee
    platformFeePercent: number;       // always 10
    pendingWithdrawals: number;       // count in "pending" or "processing"
  };
}
```

#### Get earnings history
| | |
|---|---|
| Trigger | `/dashboard/earnings` → History tab |
| Auth | Authenticated (instructor role only) |
| Method & Route | GET /api/v1/withdrawals/history |

```ts
interface ListEarningsHistoryRequest {
  page?: number;
  limit?: number;
}
```

```ts
type ListEarningsHistoryResponse = ApiResponse<PaginatedResult<{
  id: number;
  amount: number;
  description: string;
  type: "earning" | "withdrawal" | "fee";
  date: string;
  reference: string;
}>>;
```

#### Get earnings analytics
| | |
|---|---|
| Trigger | `/dashboard/earnings` → Analytics tab |
| Auth | Authenticated (instructor role only) |
| Method & Route | GET /api/v1/withdrawals/analytics |

```ts
interface EarningsAnalyticsRequest {
  period: "daily" | "weekly" | "monthly";
}
```

```ts
interface EarningsAnalyticsResponse {
  data: {
    period: string;
    enrollments: number;
    revenue: number;           // kobo
    periodLabel: string;
  }[];
}
```

#### Verify bank account
| | |
|---|---|
| Trigger | Earnings → "Bank Details" → verify modal |
| Auth | Authenticated (instructor role only) |
| Method & Route | POST /api/v1/withdrawals/verify-bank |

```ts
interface VerifyBankRequest {
  bankCode: string;          // Paystack bank code
  accountNumber: string;
}
```

```ts
interface VerifyBankResponse {
  data: {
    accountName: string;     // resolved from Paystack
    verified: boolean;
  };
}
```

#### Request withdrawal
| | |
|---|---|
| Trigger | `/dashboard/withdrawals` → request form |
| Auth | Authenticated (instructor role only) |
| Method & Route | POST /api/v1/withdrawals |

```ts
interface RequestWithdrawalRequest {
  amount: number;            // kobo
  bankCode: string;
  accountNumber: string;
  accountName: string;       // verified account name
}
```
Validation: amount ≤ availableForWithdrawal, accountNumber 10 digits (Nigerian NUBAN).

```ts
interface RequestWithdrawalResponse {
  data: {
    id: number;
    status: "pending";
    reference: string;
    estimatedArrival: string;   // "3-5 business days"
  };
}
```
> Note: Enqueues process-withdrawal job. Balance is deducted immediately.

Error cases: 400 amount exceeds available balance, 422 invalid account number.

#### List withdrawals
| | |
|---|---|
| Trigger | `/dashboard/withdrawals` page |
| Auth | Authenticated (instructor role only) |
| Method & Route | GET /api/v1/withdrawals |

```ts
interface ListWithdrawalsRequest {
  page?: number;
  limit?: number;
  filter?: { status?: "pending" | "processing" | "completed" | "failed"; };
}
```

```ts
type ListWithdrawalsResponse = ApiResponse<PaginatedResult<{
  id: number;
  amount: number;
  amountDisplay: string;
  bankName: string;
  accountNumber: string;     // masked, e.g. "••••4242"
  status: string;
  reference: string;
  requestedAt: string;
  processedAt: string | null;
}>>;
```

---

### 3.10 Communities

#### List instructor's owned/admin communities
| | |
|---|---|
| Trigger | `/dashboard/communities` page |
| Auth | Authenticated (instructor role only) |
| Method & Route | GET /api/v1/communities |

```ts
interface ListMyCommunitiesRequest {
  page?: number;
  limit?: number;
}
```

```ts
type ListMyCommunitiesResponse = ApiResponse<PaginatedResult<{
  id: number;
  name: string;
  slug: string;
  description: string;
  category: string;
  visibility: string;
  memberCount: number;
  coverImageUrl: string | null;
}>>;
```

#### List joined communities (student)
| | |
|---|---|
| Trigger | `/dashboard/my-communities` page |
| Auth | Authenticated (student role only) |
| Method & Route | GET /api/v1/communities/my |

```ts
type GetMyJoinedCommunitiesResponse = ApiResponse<{
  id: number;
  name: string;
  slug: string;
  category: string;
  memberCount: number;
  courseCount: number;
  role: string;
  joinedAt: string;
}[]>;
```

#### Create community
| | |
|---|---|
| Trigger | `/dashboard/communities/create` → "Create Community" button |
| Auth | Authenticated (instructor role only) |
| Method & Route | POST /api/v1/communities |
| Content-Type | multipart/form-data (when cover image included) |

```ts
interface CreateCommunityRequest {
  name: string;
  slug: string;
  description: string;
  category: string;
  visibility: "public" | "private" | "invite-only";
  requiresApproval: boolean;
  isPaid: boolean;
  price?: number;            // kobo, required if isPaid
  coverImage?: File;         // optional
}
```
Validation: name required (unique), slug required (unique, URL-safe), visibility ∈ valid values, price required if isPaid.

```ts
interface CreateCommunityResponse {
  data: { id: number; slug: string; };
}
```

#### Get community (manage view)
| | |
|---|---|
| Trigger | `/dashboard/communities/[slug]/manage` |
| Auth | Authenticated (community owner or admin) |
| Method & Route | GET /api/v1/communities/:slug/manage |

```ts
interface GetCommunityManageResponse {
  data: {
    id: number;
    name: string;
    slug: string;
    description: string;
    category: string;
    visibility: string;
    requiresApproval: boolean;
    isPaid: boolean;
    price: number | null;
    memberCount: number;
    courseCount: number;
    coverImageUrl: string | null;
    sequentialCourses: boolean;
    allowDownloads: boolean;
    maxConcurrentDevices: number;
    gracePeriodDays: number;
    createdAt: string;
  };
}
```

#### Update community settings
| | |
|---|---|
| Trigger | Community manage → Settings tab → "Save Changes" |
| Auth | Authenticated (community owner only) |
| Method & Route | PATCH /api/v1/communities/:slug |

```ts
interface UpdateCommunityRequest {
  name?: string;
  description?: string;
  category?: string;
  visibility?: "public" | "private" | "invite-only";
  requiresApproval?: boolean;
  isPaid?: boolean;
  price?: number | null;
  sequentialCourses?: boolean;
  allowDownloads?: boolean;
  maxConcurrentDevices?: number;
  gracePeriodDays?: number;
}
```

#### Upload community cover
| | |
|---|---|
| Auth | Authenticated (community owner) |
| Method & Route | POST /api/v1/communities/:slug/cover |
| Content-Type | multipart/form-data |

```ts
interface UploadCoverRequest {
  file: File;   // max 10MB, image/*
}
```
```ts
interface UploadCoverResponse {
  data: { coverImageUrl: string; };
}
```

#### Archive community
| | |
|---|---|
| Auth | Authenticated (community owner only) |
| Method & Route | POST /api/v1/communities/:slug/archive |
> Note: Hides community from non-members. Existing members retain access.

#### List community members
| | |
|---|---|
| Trigger | Community manage → Members tab |
| Auth | Authenticated (community admin) |
| Method & Route | GET /api/v1/communities/:slug/members |

```ts
interface ListMembersRequest {
  page?: number;
  limit?: number;
  filter?: {
    status?: "active" | "blocked" | "pending";
    role?: "admin" | "member" | "guest";
    search?: string;
  };
}
```

```ts
type ListMembersResponse = ApiResponse<PaginatedResult<{
  id: number;
  user: { id: number; name: string; initials: string; email: string; avatarUrl: string | null; };
  role: "owner" | "admin" | "member" | "guest";
  status: "active" | "blocked" | "pending";
  joinedAt: string;
}>>;
```

#### Approve/reject pending member
| | |
|---|---|
| Auth | Authenticated (community admin) |
| Method & Route | POST /api/v1/communities/:slug/members/:userId/approve |

```ts
interface ApproveMemberRequest {
  action: "approve" | "reject";
}
```

#### Toggle block member
| | |
|---|---|
| Auth | Authenticated (community admin) |
| Method & Route | POST /api/v1/communities/:slug/members/:userId/toggle-block |
> Note: Toggles between "active" and "blocked". Blocked members lose community access.

#### Change member role
| | |
|---|---|
| Auth | Authenticated (community owner only) |
| Method & Route | PATCH /api/v1/communities/:slug/members/:userId/role |

```ts
interface ChangeRoleRequest {
  role: "admin" | "member" | "guest";
}
```

#### Send invitation
| | |
|---|---|
| Auth | Authenticated (community admin) |
| Method & Route | POST /api/v1/communities/:slug/invites |

```ts
interface SendInviteRequest {
  email: string;
}
```
> Note: Enqueues send-community-invite job. Creates CommunityInvite record with status="pending".

#### Generate invite link
| | |
|---|---|
| Auth | Authenticated (community admin) |
| Method & Route | GET /api/v1/communities/:slug/invite-link |

```ts
interface InviteLinkResponse {
  data: { url: string; };
}
```

#### Join community
| | |
|---|---|
| Trigger | Community landing page → "Join Now" / "Request to Join" |
| Auth | Authenticated |
| Method & Route | POST /api/v1/communities/:slug/join |

```ts
interface JoinCommunityRequest {
  inviteCode?: string;
  paymentReference?: string;
}
```

```ts
interface JoinCommunityResponse {
  data: {
    status: "active" | "pending";
    message: string;
  };
}
```
> Note: Free + public communities → status="active" immediately. Paid → requires paymentReference. Private with requiresApproval → status="pending". Invite-only → requires inviteCode.

Error cases: 402 payment required, 403 invite-only without valid invite.

#### Leave community
| | |
|---|---|
| Auth | Authenticated (member) |
| Method & Route | POST /api/v1/communities/:slug/leave |

#### Community courses
| | |
|---|---|
| Auth | Authenticated (community admin) |
| Method & Route | GET /api/v1/communities/:slug/courses |

```ts
type GetCommunityCoursesResponse = ApiResponse<{
  id: number;
  title: string;
  slug: string;
  category: string;
  difficulty: string;
  visibility: "public" | "private";
  enrollmentCount: number;
  price: number;
  isFree: boolean;
  status: string;
}[]>;
```

#### Community feed
| | |
|---|---|
| Auth | Authenticated (community member) |
| Method & Route | GET /api/v1/communities/:slug/feed |

```ts
interface ListFeedRequest {
  page?: number;
  limit?: number;
}
```

```ts
type ListFeedResponse = ApiResponse<PaginatedResult<{
  id: number;
  author: { id: number; name: string; initials: string; role: string; };
  content: string;
  type: "post" | "announcement";
  pinned: boolean;
  likesCount: number;
  liked: boolean;
  commentsCount: number;
  createdAt: string;
  comments: {
    id: number;
    author: { name: string; initials: string; };
    text: string;
    createdAt: string;
  }[];
}>>;
```

#### Create post
| | |
|---|---|
| Auth | Authenticated (community member; "announcement" restricted to admin) |
| Method & Route | POST /api/v1/communities/:slug/feed |

```ts
interface CreatePostRequest {
  content: string;
  type: "post" | "announcement";
}
```

#### Toggle like on post
| | |
|---|---|
| Method & Route | POST /api/v1/communities/:slug/feed/:postId/like |
> Note: INSERT if not liked, DELETE if already liked. Returns updated likesCount and liked state.

#### Comment on post
| | |
|---|---|
| Method & Route | POST /api/v1/communities/:slug/feed/:postId/comments |

```ts
interface CreateCommentRequest {
  content: string;
}
```

#### Pin/unpin post
| | |
|---|---|
| Auth | Authenticated (community admin only) |
| Method & Route | POST /api/v1/communities/:slug/feed/:postId/pin |

#### Delete post
| | |
|---|---|
| Auth | Post author or community admin |
| Method & Route | DELETE /api/v1/communities/:slug/feed/:postId |

#### Community Analytics
| | |
|---|---|
| Auth | Authenticated (community admin) |
| Method & Route | GET /api/v1/communities/:slug/analytics |

```ts
interface CommunityAnalyticsResponse {
  data: {
    memberGrowth: { period: string; count: number; }[];
    engagement: { period: string; posts: number; comments: number; }[];
    enrollmentRate: { course: string; enrollments: number; }[];
  };
}
```

---

### 3.11 Messages

#### List conversations
| | |
|---|---|
| Trigger | `/dashboard/messages` page |
| Auth | Authenticated |
| Method & Route | GET /api/v1/messages/conversations |

```ts
type GetConversationsResponse = ApiResponse<{
  id: number;
  type: "direct" | "community";
  name: string;
  lastMessagePreview: string;
  lastMessageAt: string;
  unreadCount: number;
  participants: {
    id: number;
    name: string;
    initials: string;
    avatarUrl: string | null;
    online: boolean;
  }[];
}[]>;
```

#### Get conversation messages
| | |
|---|---|
| Trigger | Select a conversation |
| Auth | Authenticated (participant) |
| Method & Route | GET /api/v1/messages/conversations/:conversationId |

```ts
interface ListMessagesRequest {
  page?: number;
  limit?: number;    // paginated, infinite scroll
}
```

```ts
type ListMessagesResponse = ApiResponse<PaginatedResult<{
  id: number;
  senderId: number;
  senderName: string;
  text: string | null;
  attachment: { type: string; name: string; size: string; url: string; } | null;
  status: "sent" | "delivered" | "read";
  reaction: string | null;
  isSystem: boolean;
  createdAt: string;
}>>;
```

#### Send message
| | |
|---|---|
| Auth | Authenticated (participant) |
| Method & Route | POST /api/v1/messages/conversations/:conversationId |
| Content-Type | multipart/form-data (when attachment included) |

```ts
interface SendMessageRequest {
  text?: string;
  attachment?: File;    // max 25MB
}
```

#### Add reaction to message
| | |
|---|---|
| Method & Route | POST /api/v1/messages/conversations/:conversationId/messages/:messageId/react |

```ts
interface ReactRequest {
  reaction: string;    // emoji code
}
```

#### Mute/unmute conversation
| | |
|---|---|
| Method & Route | POST /api/v1/messages/conversations/:conversationId/toggle-mute |
> Note: Toggles `muted` on the ConversationParticipant row for the current user.

#### Pin/unpin conversation
| | |
|---|---|
| Method & Route | POST /api/v1/messages/conversations/:conversationId/toggle-pin |
> Note: Same toggle pattern as mute.

#### Mark conversation read
| | |
|---|---|
| Method & Route | POST /api/v1/messages/conversations/:conversationId/read |
> Note: Sets `lastReadAt` to now. Frontend calls this when the conversation is opened.

#### Start new direct conversation
| | |
|---|---|
| Auth | Authenticated |
| Method & Route | POST /api/v1/messages/conversations |

```ts
interface CreateConversationRequest {
  participantId: number;
}
```

```ts
interface CreateConversationResponse {
  data: { conversationId: number; };
}
```

---

### 3.12 Certificates

#### List user certificates
| | |
|---|---|
| Trigger | `/dashboard/certificates` page |
| Auth | Authenticated |
| Method & Route | GET /api/v1/certificates |

```ts
type GetCertificatesResponse = ApiResponse<{
  id: number;
  course: { title: string; slug: string; };
  code: string;
  issuedAt: string;
  completionPercent: number;
  quizScorePercent: number;
  instructorName: string;
  previewImageUrl: string | null;     // generated PDF preview
}[]>;
```

#### Get certificate preview data
| | |
|---|---|
| Trigger | CertificatePreview component |
| Auth | Authenticated (certificate owner) |
| Method & Route | GET /api/v1/certificates/:code/preview |

```ts
interface GetCertificatePreviewResponse {
  data: {
    studentName: string;
    courseTitle: string;
    instructorName: string;
    completionDate: string;
    completionPercent: number;
    quizScorePercent: number;
    code: string;
    logoUrl: string;
  };
}
```

#### Verify certificate (public)
| | |
|---|---|
| Trigger | `/verify/[code]` public page — anyone can verify |
| Auth | Public |
| Method & Route | GET /api/v1/certificates/verify/:code |

```ts
interface VerifyCertificateResponse {
  data: {
    valid: boolean;
    studentName?: string;
    courseTitle?: string;
    completionDate?: string;
    issuerName?: string;
  };
}
```
> Note: When invalid, only `valid: false` is returned. No user data leaked.

---

### 3.13 Admin

All admin endpoints require role="admin".

#### Dashboard stats
| | |
|---|---|
| Route | GET /api/v1/admin/dashboard |

```ts
interface AdminDashboardResponse {
  data: {
    totalUsers: number;
    totalCommunities: number;
    totalCourses: number;
    totalRevenue: number;           // kobo
    thisMonthRevenue: number;       // kobo
    activeUsers7d: number;
    recentSignups: { name: string; role: string; time: string; }[];
    recentPayments: { user: string; amount: number; course: string; time: string; }[];
  };
}
```

#### Manage users
| | |
|---|---|
| Route | GET /api/v1/admin/users |

```ts
interface AdminListUsersRequest {
  page?: number;
  limit?: number;
  filter?: {
    role?: string;
    status?: string;
    search?: string;
  };
}
```

```ts
type AdminListUsersResponse = ApiResponse<PaginatedResult<{
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  status: string;
  joinedAt: string;
  enrolledCourses: number;
}>>;
```

#### Get user detail
| | |
|---|---|
| Route | GET /api/v1/admin/users/:userId |

```ts
interface AdminUserDetailResponse {
  data: {
    id: number;
    firstName: string;
    lastName: string;
    email: string;
    role: string;
    phone: string | null;
    avatarUrl: string | null;
    bio: string | null;
    enrolledCourses: { id: number; title: string; progressPercent: number; }[];
    payments: { id: number; amount: number; description: string; date: string; }[];
    sessions: { device: string; ip: string; lastActiveAt: string; }[];
    status: string;
    joinedAt: string;
    deletedAt: string | null;
  };
}
```

#### Toggle user status
| | |
|---|---|
| Route | POST /api/v1/admin/users/:userId/toggle-status |
> Note: Suspend or reactivate a user account.

#### Admin communities
| | |
|---|---|
| Route | GET /api/v1/admin/communities |

```ts
interface AdminListCommunitiesRequest {
  page?: number;
  limit?: number;
  filter?: { visibility?: string; };
}
```

```ts
type AdminListCommunitiesResponse = ApiResponse<PaginatedResult<{
  id: number;
  name: string;
  slug: string;
  category: string;
  visibility: string;
  memberCount: number;
  courseCount: number;
  owner: { name: string; email: string; };
  createdAt: string;
}>>;
```

#### Admin payments
| | |
|---|---|
| Route | GET /api/v1/admin/payments |

```ts
interface AdminListPaymentsRequest {
  page?: number;
  limit?: number;
  filter?: { status?: string; type?: string; };
}
```

```ts
type AdminListPaymentsResponse = ApiResponse<PaginatedResult<{
  id: number;
  user: { name: string; email: string; };
  amount: number;
  type: string;
  description: string;
  status: string;
  reference: string;
  createdAt: string;
}>>;
```

#### Process withdrawal
| | |
|---|---|
| Route | POST /api/v1/admin/withdrawals/:withdrawalId/process |
> Note: Manually process or re-process a withdrawal.

#### Activity logs
| | |
|---|---|
| Route | GET /api/v1/admin/logs |

```ts
interface AdminListLogsRequest {
  page?: number;
  limit?: number;
  filter?: { action?: string; entity?: string; };
}
```

```ts
type AdminListLogsResponse = ApiResponse<PaginatedResult<{
  id: number;
  user: { name: string; } | null;
  action: string;
  entity: string;
  details: string;
  ip: string;
  createdAt: string;
}>>;
```

---

### 3.14 Search

#### Global search
| | |
|---|---|
| Trigger | GlobalSearchBar → type to search (debounced) |
| Auth | Authenticated |
| Method & Route | GET /api/v1/search |

```ts
interface SearchRequest {
  q: string;        // query param, required, min 2 chars
}
```

```ts
interface SearchResponse {
  data: {
    communities: { id: number; name: string; slug: string; category: string; memberCount: number; }[];
    courses: { id: number; title: string; slug: string; category: string; instructor: string; }[];
    people: { id: number; name: string; initials: string; role: string; }[];
  };
}
```
> Note: Searches across all three entity types. Results limited to top 5 per category. Only public entities are searchable (private courses/communities excluded).

---

## 4. Queues & Background Workers

### EmailQueue

> Note: All emails run in background because SMTP delivery latency (50-500ms+) must never block HTTP responses. Failure is handled with retry (3 attempts, exponential backoff).

| Job name | Payload | Triggered by |
|---|---|---|
| send-otp-email | `SendOtpEmailJob` | auth/register, auth/forgot-password |
| send-welcome-email | `SendWelcomeEmailJob` | auth/verify-otp (signup source) |
| send-password-reset-confirmation | `SendPasswordResetJob` | auth/reset-password |
| send-community-invite | `SendCommunityInviteJob` | communities/:slug/invites |
| send-payment-receipt | `SendPaymentReceiptJob` | payments/verify (success) |

```ts
interface SendOtpEmailJob {
  email: string;
  otp: string;
  expiresInSeconds: number;
}

interface SendWelcomeEmailJob {
  userId: number;
  email: string;
  firstName: string;
}

interface SendPasswordResetJob {
  userId: number;
  email: string;
}

interface SendCommunityInviteJob {
  email: string;
  communityName: string;
  inviteUrl: string;
  inviterName: string;
}

interface SendPaymentReceiptJob {
  userId: number;
  email: string;
  paymentId: number;
  amount: number;
  description: string;
  reference: string;
}
```

### NotificationQueue

> Note: In-app notifications are created synchronously but push/email delivery is backgrounded. Bulk community notifications can fan out to thousands of users.

| Job name | Payload | Triggered by |
|---|---|---|
| send-in-app-notification | `SendNotificationJob` | enrollment, review, comment, grading, announcement |
| send-push-notification | `SendPushJob` | any notification where user has push enabled |
| send-bulk-community-notification | `SendBulkCommunityNotificationJob` | community announcement post |

```ts
interface SendNotificationJob {
  userId: number;
  type: "enrollment" | "submission" | "payment" | "review" | "badge" | "class" | "feedback" | "announcement";
  title: string;
  body: string;
  actionUrl: string | null;
}

interface SendPushJob {
  userId: number;
  title: string;
  body: string;
}

interface SendBulkCommunityNotificationJob {
  communityId: number;
  type: string;
  title: string;
  body: string;
  actionUrl: string | null;
}
```

### WithdrawalQueue

> Note: Paystack Transfer API can take 2-5 seconds per request. Withdrawals are processed asynchronously so the instructor doesn't wait on a loading spinner.

| Job name | Payload | Triggered by |
|---|---|---|
| process-withdrawal | `ProcessWithdrawalJob` | withdrawals (POST) |

```ts
interface ProcessWithdrawalJob {
  withdrawalId: number;
}
```

### CertificateQueue

> Note: PDF generation is CPU-intensive (rendering HTML → PDF with student name, course title, completion date). Offloading prevents request timeouts.

| Job name | Payload | Triggered by |
|---|---|---|
| generate-certificate | `GenerateCertificateJob` | enrollment completion (progress = 100% + meets requirements) |

```ts
interface GenerateCertificateJob {
  enrollmentId: number;
  userId: number;
  courseId: number;
}
```

### BillingQueue

> Note: Scheduled jobs run on a cron, not per-request. They find subscriptions due for renewal and charge via Paystack recurring.

| Job name | Payload | Schedule | Description |
|---|---|---|---|
| process-subscriptions | `ProcessSubscriptionsJob` | Daily | Find subscriptions due for renewal, charge via Paystack, extend enrollment expiry |
| expire-grace-period | `ExpireGracePeriodJob` | Daily | Find subscriptions past grace period, suspend access |

```ts
interface ProcessSubscriptionsJob {}    // no payload — queries DB for due subscriptions

interface ExpireGracePeriodJob {}       // no payload — queries DB for past-grace subscriptions
```

---

## 5. Open Questions

1. **Live class integration** — The demo data uses Google Meet links (`meet.google.com`). Should the backend auto-create meeting rooms on lesson publish, or rely on instructors pasting their own links?

2. **Drip content schedule** — The `dripContent` toggle exists but no schedule UI is in the frontend. Proposed model: each Lesson gets an optional `releaseAfterDays` field (days from enrollment). Confirm?

3. **Referral codes** — Checkout dialog includes a referral code field. Are codes per-instructor, per-course, or global? What's the discount rule (e.g., 10% off, applied to platform fee)?

4. **Video hosting provider** — VideoPlayer uses URL embeds. Which provider? YouTube/Vimeo (URL validation) or Mux/Cloudflare Stream (API integration for uploads and signed playback)?

5. **Push notification provider** — Firebase Cloud Messaging? A device-token registration endpoint (`POST /api/v1/users/me/devices`) would be needed.

6. **Admin account creation** — No admin registration flow exists in the frontend. Is there a seed script for the first admin, or a super-admin invite mechanism?

7. **Parent enrollment record** — When a parent pays for a child, the Enrollment has `userId = child` and `enrolledById = parent`. Does the parent get any access to the course content themselves, or only progress monitoring?

8. **Course duplication** — The curriculum editor shows a copy/duplicate icon. Should the backend support cloning a lesson, module, or entire course into a new course?

9. **File storage** — Local disk, S3-compatible (Cloudflare R2), or another provider? The spec assumes signed URLs returned by upload endpoints.

10. **OTP delivery channel** — Currently only email. Is SMS OTP needed for Nigerian market (Termii, Africa's Talking)? This would affect the `send-otp-email` job and add phone number verification.
