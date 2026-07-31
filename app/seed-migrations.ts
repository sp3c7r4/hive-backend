// Run on every deploy: NODE_ENV=production node dist/seed-migrations.js
// Ensures __drizzle_migrations is seeded with hashes of all existing migration
// files so drizzle skips them and only runs new migrations.
import { Pool } from "pg";
import { config } from "@/config";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const migrationsDir = join(import.meta.dirname, "migrations");

if (!existsSync(migrationsDir)) {
	console.error("No migrations directory found at", migrationsDir);
	process.exit(1);
}

const pool = new Pool({ connectionString: config.db.uri });

// Create tracking table (idempotent)
await pool.query(`
	CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
		id SERIAL PRIMARY KEY,
		hash text NOT NULL,
		created_at bigint
	)
`);

// Ensure hash column has a unique index (for idempotent inserts)
await pool.query(`
	DO $$ BEGIN
		IF NOT EXISTS (
			SELECT 1 FROM pg_indexes
			WHERE tablename = '__drizzle_migrations'
			AND indexname = '__drizzle_migrations_hash_unique'
		) THEN
			CREATE UNIQUE INDEX "__drizzle_migrations_hash_unique"
			ON "__drizzle_migrations" (hash);
		END IF;
	END $$;
`);

const sqlFiles = readdirSync(migrationsDir)
	.filter((f) => f.endsWith(".sql"))
	.sort();

for (const file of sqlFiles) {
	const content = readFileSync(join(migrationsDir, file), "utf-8");
	const hash = createHash("sha256").update(content).digest("hex");

	await pool.query(
		`INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES ($1, 0) ON CONFLICT (hash) DO NOTHING`,
		[hash],
	);
	console.log(`  ✓ ${file}`);
}

await pool.end();
console.log(`\n⚡Seeded ${sqlFiles.length} migrations.`);
