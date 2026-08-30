// Dev fixture seeder — recreates the known dev users + a paid course +
// community after a fresh migration. Idempotent (ON CONFLICT DO NOTHING).
// NOTE: password-less rows — dev sessions are minted via Redis (see
// scripts/e2e/common.py), so no credential hashes are needed here.
import { Pool } from "pg";
import { config } from "@/config";

const pool = new Pool({ connectionString: config.db.uri });

const users: Array<[number, string, string, string]> = [
  [5, "Sarafa", "Satae", "sarafasatar@gmail.com"],
  [6, "Testing", "User", "vekogep220@murkstar.com"],
  [8, "Invite", "Tester", "invite.tester@hive.test"],
  [10, "John", "Doe", "salomih362@robustq.com"],
];

for (const [id, first, last, email] of users) {
  await pool.query(
    `INSERT INTO users (id, first_name, last_name, email, onboarded) OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4, true)
     ON CONFLICT (id) DO NOTHING`,
    [id, first, last, email],
  );
}

const roles: Array<[number, string]> = [
  [5, "instructor"],
  [5, "student"],
  [6, "student"],
  [8, "student"],
  [10, "student"],
];
for (const [userId, role] of roles) {
  await pool.query(
    `INSERT INTO user_roles (user_id, role) VALUES ($1,$2)
     ON CONFLICT (user_id, role) DO NOTHING`,
    [userId, role],
  );
}

// Instructor profile + admin flag for user 5 (admin withdrawals queue)
await pool.query(
  `INSERT INTO instructor_profiles (user_id, is_admin)
   SELECT 5, true WHERE NOT EXISTS (SELECT 1 FROM instructor_profiles WHERE user_id = 5)`,
);

// Community owned by 5, members 6 + 10
await pool.query(
  `INSERT INTO communities (id, owner_id, name, slug, visibility) OVERRIDING SYSTEM VALUE
   VALUES (9, 5, 'Typescript', 'typescript-5', 'public')
   ON CONFLICT (id) DO NOTHING`,
);
for (const userId of [6, 10]) {
  await pool.query(
    `INSERT INTO community_members (community_id, user_id, role, member_role, status)
     VALUES (9, $1, 'student', 'member', 'active')
     ON CONFLICT (community_id, user_id) DO NOTHING`,
    [userId],
  );
}

// Paid course owned by instructor 5 (price 50000 kobo = ₦500)
await pool.query(
  `INSERT INTO courses (id, instructor_id, community_id, title, slug, price, status, visibility) OVERRIDING SYSTEM VALUE
   VALUES (3, 5, 9, 'Car course', 'car-course-3', 50000, 'published', 'public')
   ON CONFLICT (id) DO NOTHING`,
);

// Free course
await pool.query(
  `INSERT INTO courses (id, instructor_id, community_id, title, slug, price, status, visibility) OVERRIDING SYSTEM VALUE
   VALUES (4, 5, 9, 'Introduction to TypeScript', 'introduction-to-typescript', 0, 'published', 'public')
   ON CONFLICT (id) DO NOTHING`,
);

await pool.end();
console.log("✅ dev fixtures seeded (users 5/6/8/10, roles, courses 3/4, community 9).");
