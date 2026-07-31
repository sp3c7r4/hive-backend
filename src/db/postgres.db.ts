import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "@/config";
import * as schema from "@/db/postgres.schema";
import { logger } from "@/utils";

const pool = new Pool({
	connectionString: config.db.uri,
	max: 10,
});

let _db: ReturnType<typeof drizzle<typeof schema>>;

export const connectPostgresDB = async (server: () => void) => {
	try {
		_db = drizzle({ client: pool, schema: schema });
		await _db.execute("select 1");
		logger.info("Connected to postgres db 🐘");
		server();
	} catch (e: unknown) {
		logger.error(
			`Error connecting to PostgreSQL: ${e instanceof Error ? e.message : "Unknown error"}`,
		);
		throw e;
	}
};

export const getDb = () => {
	if (!_db) throw new Error("Database not initialized");
	return _db;
};
