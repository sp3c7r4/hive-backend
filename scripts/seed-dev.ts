// Dev fixture seeder — idempotent, email-based. Creates the known dev users
// (reusing existing rows by email), the instructor profile, a paid + a free
// course, and a community with members. Prints the resolved ids.
import { Pool } from "pg";
import { config } from "@/config";

const pool = new Pool({ connectionString: config.db.uri });

const users = [
  ["Sarafa", "Satae", "sarafasatar@gmail.com"],
  ["Testing", "User", "vekogep220@murkstar.com"],
  ["Test", "Student", "test-student@gmail.com"],
];

const userIds: Record<string, number> = {};
for (const [first, last, email] of users) {
  const ins = await pool.query(
    `INSERT INTO users (first_name, last_name, email, onboarded)
     VALUES ($1,$2,$3, true)
     ON CONFLICT (email) DO UPDATE SET onboarded = true
     RETURNING id`,
    [first, last, email],
  );
  userIds[email] = ins.rows[0].id as number;
}

const instructorId = userIds["sarafasatar@gmail.com"];
const studentEmail = users.find((u) => u[1] === "Student")![2];
const studentId = userIds[studentEmail];

// Roles (user_roles unique on (user_id, role))
for (const [email, role] of [
  ["sarafasatar@gmail.com", "instructor"],
  ["sarafasatar@gmail.com", "student"],
  [studentEmail, "student"],
] as const) {
  await pool.query(
    `INSERT INTO user_roles (user_id, role) VALUES ($1,$2)
     ON CONFLICT (user_id, role) DO NOTHING`,
    [userIds[email], role],
  );
}

// Instructor profile + admin flag
await pool.query(
  `INSERT INTO instructor_profiles (user_id, is_admin)
   SELECT $1, true WHERE NOT EXISTS (SELECT 1 FROM instructor_profiles WHERE user_id = $1)`,
  [instructorId],
);

// Community first (courses reference it)
const comm = await pool.query(
  `INSERT INTO communities (owner_id, name, slug, visibility)
   VALUES ($1, 'Typescript', 'typescript-5', 'public')
   ON CONFLICT (slug) DO NOTHING
   RETURNING id`,
  [instructorId],
);
let communityId = comm.rows[0]?.id;
if (!communityId) {
  const r = await pool.query(`SELECT id FROM communities WHERE slug = 'typescript-5'`);
  communityId = r.rows[0].id as number;
}

// Courses (paid 50000 kobo + free)
const courseA = await pool.query(
  `INSERT INTO courses (instructor_id, community_id, title, slug, price, status, visibility)
   VALUES ($1, $2, 'Car course', 'car-course-3', 50000, 'published', 'public')
   ON CONFLICT (slug) DO NOTHING
   RETURNING id`,
  [instructorId, communityId],
);
const courseB = await pool.query(
  `INSERT INTO courses (instructor_id, community_id, title, slug, price, status, visibility)
   VALUES ($1, $2, 'Introduction to TypeScript', 'introduction-to-typescript', 0, 'published', 'public')
   ON CONFLICT (slug) DO NOTHING
   RETURNING id`,
  [instructorId, communityId],
);
const paidCourseId =
  courseA.rows[0]?.id ?? (await pool.query(`SELECT id FROM courses WHERE slug='car-course-3'`)).rows[0].id;

// Community members
for (const uid of [studentId, userIds["vekogep220@murkstar.com"]]) {
  await pool.query(
    `INSERT INTO community_members (community_id, user_id, role, member_role, status)
     VALUES ($1, $2, 'student', 'member', 'active')
     ON CONFLICT (community_id, user_id) DO NOTHING`,
    [communityId, uid],
  );
}

await pool.end();
console.log(
  `✅ fixtures: instructor=${instructorId} student=${studentId} paidCourse=${paidCourseId} community=${communityId}`,
);
