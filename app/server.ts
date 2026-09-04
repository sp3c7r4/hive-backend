import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { HonoAdapter } from "@bull-board/hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { WebSocketServer } from "ws";
import { config } from "@/config";
import { connectPostgresDB, connectRedisDB } from "@/db";
import { healthCheck } from "@/helpers";
import { errorHandler, RequestLogger, routeNotFound } from "@/middlewares";
import { router } from "@/routes";
import { EmailQueueService } from "@/services";
import { LessonChunkQueueService } from "@/services/queues/lesson-chunk.queue.service";
import { CertificateQueueService } from "@/services/queues/certificate.queue.service";
import { ReceiptQueueService } from "@/services/queues/receipt.queue.service";
import { SubscriptionExpiryQueueService } from "@/services/queues/subscription-expiry.queue.service";
import { GradingQueueService } from "@/services/queues/grading.queue.service";
import { messagingWsHandler } from "@/modules/messaging/messaging.ws";
import { logger } from "@/utils";

const app = new Hono({
	strict: false,
});

let PORT: number = config.server.port;

/** @info - WebSocket endpoint. Registered BEFORE CORS/RequestLogger —
 *          header-modifying middleware breaks the Hono WS upgrade. */
app.get("/ws", messagingWsHandler);

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
		new BullMQAdapter(EmailQueueService.getInstance().getQueue()),
		new BullMQAdapter(LessonChunkQueueService.getInstance().getQueue()),
		new BullMQAdapter(CertificateQueueService.getInstance().getQueue()),
		new BullMQAdapter(ReceiptQueueService.getInstance().getQueue()),
		new BullMQAdapter(SubscriptionExpiryQueueService.getInstance().getQueue()),
		new BullMQAdapter(GradingQueueService.getInstance().getQueue()),
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
	const wss = new WebSocketServer({ noServer: true });
	server = serve({
		fetch: app.fetch,
		hostname: config.server.hostname,
		port: port,
		websocket: { server: wss },
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

// Initialize PostgreSQL and Redis
connectPostgresDB(startServer);
connectRedisDB();

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
