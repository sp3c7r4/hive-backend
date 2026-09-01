// Drop the public schema (types + tables + tracking) and re-run all
// migrations from scratch. ONLY for dev — destroys all data in this DB.
import { Pool } from "pg";
import { config } from "@/config";

if (process.env.NODE_ENV === "production") {
	console.error("migrate:rebuild refuses to run in production. This script drops the entire database.");
	process.exit(1);
}

const pool = new Pool({ connectionString: config.db.uri });
await pool.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;");
await pool.end();
console.log("✅ schema dropped — run `npm run migrate` to rebuild, then `npm run seed:dev`.");
