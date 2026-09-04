import type { Context } from "hono";
import { sendSuccessResponse } from "@/helpers";
import { AiGradingService } from "./ai-grading.service";
import { GradingPubSubService } from "@/services/engine/grading-pubsub.service";

export class AiGradingController {
	private static instance: AiGradingController;
	private readonly service = AiGradingService.getInstance();
	private readonly pubsub = GradingPubSubService.getInstance();

	static getInstance(): AiGradingController {
		if (!this.instance) this.instance = new AiGradingController();
		return this.instance;
	}

	/** @info - POST /ai/grading/single — one AI suggestion */
	suggest = async (c: Context) => {
		const authData = c.get("authData");
		const body = await c.req.json();
		const suggestion = await this.service.suggest(authData.id, body);
		return sendSuccessResponse(c, { suggestion });
	};

	/** @info - POST /ai/grading/batches — start a mass grading run */
	massGrade = async (c: Context) => {
		const authData = c.get("authData");
		const body = await c.req.json();
		const result = await this.service.massGrade(authData.id, body);
		return sendSuccessResponse(c, result);
	};

	/** @info - GET /ai/grading/batches/:batchId — snapshot (drawer anchor) */
	batchSnapshot = async (c: Context) => {
		const authData = c.get("authData");
		const batchId = Number(c.req.param("batchId"));
		const snapshot = await this.service.batchSnapshot(authData.id, batchId);
		return sendSuccessResponse(c, snapshot);
	};

	/** @info - GET /ai/grading/batches/running — reload rediscovery */
	runningBatch = async (c: Context) => {
		const authData = c.get("authData");
		const result = await this.service.runningBatch(authData.id);
		return sendSuccessResponse(c, { data: result });
	};

	/** @info - GET /ai/grading/batches/:batchId/stream — SSE forwarder */
	stream = async (c: Context) => {
		const authData = c.get("authData");
		const batchId = Number(c.req.param("batchId"));
		await this.service.assertBatchOwner(authData.id, batchId);

		let enqueue: ((chunk: string) => void) | null = null;
		let detach: (() => void) | null = null;
		const stream = new ReadableStream<string>({
			start(controller) {
				enqueue = (chunk) => controller.enqueue(chunk);
			},
			cancel() {
				enqueue = null;
				detach?.();
				detach = null;
			},
		});

		detach = await this.pubsub.createSubscriber(batchId, (event) => {
			enqueue?.(`data: ${JSON.stringify(event)}\n\n`);
		});

		return c.body(stream, 200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
	};

	/** @info - GET /ai/grading/review?courseId= — unreviewed suggestions */
	reviewList = async (c: Context) => {
		const authData = c.get("authData");
		const courseId = Number(c.req.query("courseId"));
		const rows = await this.service.reviewList(authData.id, courseId);
		return sendSuccessResponse(c, { data: rows });
	};

	/** @info - POST /ai/grading/review/:submissionId/decline */
	decline = async (c: Context) => {
		const authData = c.get("authData");
		const submissionId = Number(c.req.param("submissionId"));
		const result = await this.service.decline(authData.id, submissionId);
		return sendSuccessResponse(c, result);
	};

	/** @info - POST /ai/grading/review/:submissionId/regenerate */
	regenerate = async (c: Context) => {
		const authData = c.get("authData");
		const submissionId = Number(c.req.param("submissionId"));
		const suggestion = await this.service.regenerate(authData.id, submissionId);
		return sendSuccessResponse(c, { suggestion });
	};

	/** @info - PATCH /ai/grading/review/:submissionId/approve */
	approve = async (c: Context) => {
		const authData = c.get("authData");
		const submissionId = Number(c.req.param("submissionId"));
		const body = await c.req.json();
		const result = await this.service.approve(authData.id, submissionId, body);
		return sendSuccessResponse(c, result);
	};
}
