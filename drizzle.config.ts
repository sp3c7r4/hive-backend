import { defineConfig } from "drizzle-kit";
import { config } from "@dotenvx/dotenvx";

const getEnvFile = () => `.env.${process.env.NODE_ENV || "development"}`;
const envFile = getEnvFile();

config({ path: envFile, override: true });

export default defineConfig({
	schema: ["./src/**/*.model.ts"],
	out: "./src/db/migrations",
	dialect: "postgresql",
	dbCredentials: {
		url: process.env.POSTGRES_URI!,
	},
});
