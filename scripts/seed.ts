/**
 * Database seed script. Populates dev/test database with fixture data.
 *
 * Run via: npm run seed
 */

import { config } from "@/config/config";

async function seed() {
	console.log("[Seed] Seeding database...");
	// Add seed logic here
	console.log("[Seed] Complete.");
	process.exit(0);
}

seed().catch((error) => {
	console.error("[Seed] Failed:", error);
	process.exit(1);
});
