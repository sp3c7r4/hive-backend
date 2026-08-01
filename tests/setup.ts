/**
 * Test setup — runs once before all tests.
 *
 * Creates a Hono test app that mirrors the real app's middleware and routes,
 * connected to a test Postgres database.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "@/config";
import { errorHandler, routeNotFound } from "@/middlewares";
import { router } from "@/routes";

console.log("[Test] Setup loaded.");

/** Build a clean Hono app wired to all routes for integration testing */
export function createTestApp(): Hono {
	const app = new Hono({ strict: false });

	app.use(
		"*",
		cors({
			origin: "*",
			allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
			allowHeaders: ["Content-Type", "Authorization", "Accept"],
		}),
	);

	app.route("/api/v1", router);

	app.use("*", routeNotFound);
	app.onError(errorHandler);

	return app;
}

/** Singleton test app — reuse across test files */
export const testApp = createTestApp();
