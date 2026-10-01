/* Applies a curriculum manifest to a course that already exists in the database.
 *
 *   node scripts/curriculum/apply-curriculum.mjs --slug <slug> --manifest <file.mjs> [--dry] [--create]
 *
 *   --dry      print the diff, write nothing (the safe first run)
 *   --create   also create content lessons the plan lists and the course lacks;
 *              without it, a lesson that is not there is reported and skipped, so
 *              an instructor's own lessons can never be duplicated
 *
 * Built for cloud-ai-15, where the lessons existed and the quizzes and the weekly
 * assessments did not. Matching is the safety property: content lessons match on
 * their exact title, quizzes and assessments match on their NUMBER, so "Quiz 1",
 * "Lesson 1 Quiz" and "Module 2 Quiz" are recognised rather than duplicated. An
 * existing module-level quiz is reused as its module's last lesson quiz instead of
 * being orphaned next to a new empty one, and nothing is ever deleted.
 *
 * It runs where the database is reachable — for production that is the app box,
 * through SSM:
 *
 *   aws ssm send-command --profile hive --targets Key=tag:Name,Values=hive-backend ...
 */
import { readFileSync } from "node:fs";
import pg from "pg";

const flag = (name) => process.argv.includes(`--${name}`);
const value = (name) => {
	const i = process.argv.indexOf(`--${name}`);
	return i > -1 ? process.argv[i + 1] : undefined;
};

const APP = "/home/ec2-user/hive-backend";
const DRY = flag("dry");
/* @info - Content lessons are only created when asked for. The instructor's own
 * lessons are the authority; this flag is for the ones their plan lists and never
 * got written. */
const CREATE = flag("create");
const SLUG = value("slug");
const MANIFEST = value("manifest");
if (!SLUG || !MANIFEST) {
	console.error("usage: apply-curriculum.mjs --slug <slug> --manifest <file.mjs> [--dry] [--create]");
	process.exit(2);
}
const { CURRICULUM } = await import(new URL(MANIFEST, `file://${process.cwd()}/`).href);

const env = Object.fromEntries(
	readFileSync(`${APP}/.env.production`, "utf8")
		.split("\n")
		.filter((l) => l.includes("=") && !l.trim().startsWith("#"))
		.map((l) => {
			const i = l.indexOf("=");
			return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
		}),
);
const db = new pg.Client({ connectionString: env.POSTGRES_URI, ssl: { rejectUnauthorized: false } });
await db.connect();

const course = (await db.query("SELECT id, status FROM courses WHERE slug = $1", [SLUG])).rows[0];
if (!course) throw new Error(`course ${SLUG} not found`);
const modules = (
	await db.query("SELECT id, title, sort_order FROM modules WHERE course_id = $1 ORDER BY sort_order, id", [course.id])
).rows;
const allLessons = (
	await db.query(
		"SELECT id, module_id, title, type, status, sort_order FROM lessons WHERE module_id = ANY($1::int[]) ORDER BY sort_order, id",
		[modules.map((m) => m.id)],
	)
).rows;

const log = [];
const stats = { created: 0, renamed: 0, reordered: 0, kept: 0 };
const boundary = (n) => new RegExp(`\\b${n}\\b`);
const asks = (title, kind, n) => {
	const t = (title || "").toLowerCase();
	if (!t.includes(kind)) return false;
	return boundary(n).test(t);
};
const lessonNumberAt = (mi, li) =>
	CURRICULUM.slice(0, mi).reduce((n, m) => n + m.lessons.length, 0) + li + 1;

for (const [mi, planned] of CURRICULUM.entries()) {
	let mod = modules.find(
		(m) =>
			m.title === planned.title ||
			m.title.toLowerCase().startsWith(planned.title.split(" (")[0].toLowerCase()),
	);
	if (!mod) {
		log.push(`+ module "${planned.title}"`);
		stats.created++;
		if (!DRY) {
			mod = (
				await db.query("INSERT INTO modules (course_id, title, sort_order) VALUES ($1,$2,$3) RETURNING id, title", [
					course.id,
					planned.title,
					mi,
				])
			).rows[0];
			modules.push(mod);
		} else continue; // nothing to hang lessons off in a dry run
	}

	const rows = allLessons.filter((l) => l.module_id === mod.id);
	/* @info - New rows carry the status the instructor's own lessons carry, so the
	 * course never ends up half published because of this script. */
	const inherited = rows[0]?.status ?? course.status ?? "draft";
	const unclaimed = rows.filter((l) => l.type === "quiz" && /module\s*\d+\s*quiz/i.test(l.title));
	const claimed = new Set();

	const wanted = [];
	const missingNumbers = new Set();
	planned.lessons.forEach((lesson, li) => {
		const n = lessonNumberAt(mi, li);
		wanted.push({ title: lesson.title, type: "video", sortOrder: wanted.length, number: n });
		wanted.push({ title: `Lesson ${n} Quiz`, type: "quiz", sortOrder: wanted.length, number: n, last: li === planned.lessons.length - 1 });
		for (const a of planned.assessments.filter((x) => x.afterLessonIndex === li)) {
			wanted.push({
				title: a.title,
				type: "assessment",
				sortOrder: wanted.length,
				number: Number((a.title.match(/(\d+)/) || [])[1] ?? 0),
				anchor: n,
			});
		}
	});

	for (const item of wanted) {
		let found =
			item.type === "video"
				? rows.find((l) => l.type === "video" && l.title === item.title)
				: rows.find((l) => l.type === item.type && asks(l.title, item.type, item.number) && !claimed.has(l.id));

		/* @info - A module-level quiz the instructor already wrote is reused as the
		 * last lesson's quiz rather than orphaned next to a new empty one. */
		if (!found && item.type === "quiz" && item.last) {
			found = unclaimed.find((l) => !claimed.has(l.id));
			if (found) log.push(`~ reusing "${found.title}" as "${item.title}"`);
		}
		if (found) claimed.add(found.id);

		if (!found && item.type === "video") {
			if (!CREATE) {
				log.push(`! no content lesson titled "${item.title}" — left alone`);
				missingNumbers.add(item.number);
				continue;
			}
			log.push(`+ video "${item.title}" at ${item.sortOrder} (from the plan)`);
			stats.created++;
			if (!DRY) {
				const created = (
					await db.query(
						"INSERT INTO lessons (module_id, title, type, sort_order, status) VALUES ($1,$2,$3,$4,$5) RETURNING id",
						[mod.id, item.title, "video", item.sortOrder, inherited],
					)
				).rows[0];
				rows.push({ id: created.id, module_id: mod.id, title: item.title, type: "video", status: inherited, sort_order: item.sortOrder });
			}
			continue;
		}
		/* @info - An assessment belongs to the lesson it closes: without that lesson on
		 * the module, its paper is skipped with it rather than left hanging. */
		if (item.type !== "video" && (missingNumbers.has(item.number) || (item.anchor && missingNumbers.has(item.anchor)))) {
			log.push(`! "${item.title}" skipped: no Lesson ${item.number} to test`);
			continue;
		}

		if (found) {
			if (found.title !== item.title) {
				log.push(`~ rename "${found.title}" -> "${item.title}"`);
				stats.renamed++;
				if (!DRY) await db.query("UPDATE lessons SET title = $1 WHERE id = $2", [item.title, found.id]);
			}
			if (found.sort_order !== item.sortOrder) {
				log.push(`~ order "${item.title}" ${found.sort_order} -> ${item.sortOrder}`);
				stats.reordered++;
				if (!DRY) await db.query("UPDATE lessons SET sort_order = $1 WHERE id = $2", [item.sortOrder, found.id]);
			}
			if (found.title === item.title && found.sort_order === item.sortOrder) stats.kept++;
			continue;
		}

		log.push(`+ ${item.type} "${item.title}" at ${item.sortOrder}`);
		stats.created++;
		if (!DRY) {
			const created = (
				await db.query(
					"INSERT INTO lessons (module_id, title, type, sort_order, status) VALUES ($1,$2,$3,$4,$5) RETURNING id",
					[mod.id, item.title, item.type, item.sortOrder, inherited],
				)
			).rows[0];
			rows.push({ id: created.id, module_id: mod.id, title: item.title, type: item.type, status: inherited, sort_order: item.sortOrder });
		}
	}
}

console.log(`${DRY ? "DRY RUN" : "APPLIED"} — created ${stats.created}, renamed ${stats.renamed}, reordered ${stats.reordered}, already right ${stats.kept}`);
console.log(log.join("\n"));
await db.end();
