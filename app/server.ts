import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { HonoAdapter } from "@bull-board/hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "@/config";
import { connectPostgresDB, connectRedisDB } from "@/db";
import { healthCheck } from "@/helpers";
import { errorHandler, RequestLogger, routeNotFound } from "@/middlewares";
import { router } from "@/routes";
import {
	EmailQueueService
} from "@/services";
import { logger } from "@/utils";

const app = new Hono({
	strict: false,
});

let PORT: number = config.server.port;

/** @info - CORS middleware */
app.use(
	"*",
	cors({
		origin: "*",
		allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization", "Accept"],
	}),
);

const getMessage = (port: number) => `
================================================
Server Application Started!
API V1: http://${config.server.hostname}:${port}
API Docs: http://${config.server.hostname}:${port}/docs
QUEUE Dashboard: http://${config.server.hostname}:${port}/queue
================================================
`;

app.use("*", RequestLogger);
app.use("/favicon.ico", serveStatic({ path: "./public/logo.png" }));

app.get("/", healthCheck);

app.route("/api/v1", router);

/** Bull MQ Dashboard */
const bullMQAdapter = new HonoAdapter(serveStatic);
bullMQAdapter.setBasePath("/queue");

createBullBoard({
	queues: [
		new BullMQAdapter(EmailQueueService.getInstance().getQueue())
	],
	serverAdapter: bullMQAdapter,
	options: {
		uiConfig: {
			favIcon: {
				default: "./public/logo.png",
				alternative: "./public/logo.png",
			},
		},
	},
});

app.route("/queue", bullMQAdapter.registerPlugin());

let server: ReturnType<typeof serve>;

function startServer(port: number = PORT) {
	server = serve({
		fetch: app.fetch,
		hostname: config.server.hostname,
		port: port,
	});

	/** @info - Displays server started message */
	console.log(getMessage(port));
	server.on("error", (err) => {
		if (err instanceof Error && (err as any).code === "EADDRINUSE") {
			const newPort = port + 1;
			logger.error(
				`Port ${port} is already in use. Retrying with port ${newPort}`,
			);
			PORT = newPort;
			setTimeout(() => {
				server.close();
				startServer(newPort);
			}, 1000);
		} else {
			logger.error(
				`Failed to start server: ${err instanceof Error ? err.message : "Unknown error"}`,
			);
			throw err;
		}
	});
}

// Initialize MongoDB and Redis
connectPostgresDB(startServer);
connectRedisDB();

app.get("/", (c) => c.text("Hello World"));

app.use("*", routeNotFound);

app.onError((err: Error & { code?: string }, c) => {
	return errorHandler(err, c);
});

/** @info - We're handling all Server closures */
process.on("SIGINT", () => {
	server.close();
	process.exit(0);
});

process.on("SIGTERM", () => {
	server.close();
	process.exit(0);
});
