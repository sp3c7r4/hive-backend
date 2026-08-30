// Custom migration runner — replaces drizzle's migrate() which has opaque
// hash matching that fails on pre-seeded DBs. This reads .sql files, checks
// __drizzle_migrations for already-applied hashes, and runs only new ones.
import { Pool } from "pg";
import { config } from "@/config";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const migrationsDir = join(import.meta.dirname, "..", "src", "db", "migrations");
const pool = new Pool({ connectionString: config.db.uri });

// Ensure tracking table exists
await pool.query(`
	CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
		id SERIAL PRIMARY KEY,
		hash text NOT NULL UNIQUE,
		created_at bigint
	)
`);

const sqlFiles = readdirSync(migrationsDir)
	.filter((f) => f.endsWith(".sql"))
	.sort();

let applied = 0;
let skipped = 0;

for (const file of sqlFiles) {
	const sql = readFileSync(join(migrationsDir, file), "utf-8");
	const hash = createHash("sha256").update(sql).digest("hex");

	// Check if already applied (including seeded entries)
	const { rows } = await pool.query(
		`SELECT 1 FROM "__drizzle_migrations" WHERE hash = $1`,
		[hash],
	);

	if (rows.length > 0) {
		skipped++;
		continue;
	}

	// Split on drizzle's statement breakpoints, run each statement
	const statements = sql
		.split("--> statement-breakpoint")
		.map((s) => s.trim())
		.filter(Boolean);

	await pool.query("BEGIN");
	try {
		for (const stmt of statements) {
			await pool.query(stmt);
		}
		await pool.query(
			`INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
			[hash, Date.now()],
		);
		await pool.query("COMMIT");
		applied++;
		console.log(`  ✓ ${file}`);
	} catch (e: any) {
		await pool.query("ROLLBACK");
		// Duplicate-object errors are safe — already exists in DB
		if (e?.code === "42710" || e?.code === "42P07" || e?.code === "42P16" || e?.code === "42701" || e?.code === "42704") {
			await pool.query(
				`INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
				[hash, Date.now()],
			);
			skipped++;
		} else {
			console.error(`  ✗ ${file}: ${e.message}`);
			throw e;
		}
	}
}

await pool.end();
console.log(`\n⚡${applied} applied, ${skipped} skipped.`);
