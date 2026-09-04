import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * @info - GradingWorkerService batch finalize semantics. The real race
 * protection is the atomic UPDATE...RETURNING in the DB; what this test
 * pins is the logic around it: with N concurrent job completions the
 * batch finalizes EXACTLY once and batch-complete publishes exactly once,
 * no matter the interleaving.
 */

const state = vi.hoisted(() => ({
	completed: 0,
	total: 0,
	finalizeCalls: 0,
	publishCalls: [] as string[],
	suggestionResults: [] as Array<{ score: number; feedback: string } | null>,
}));

const dbChain: any = {
	update: () => ({
		set: (payload: any) => ({
			where: () => {
				/* @info - Eager side effect + thenable: the worker awaits
				 * .where() directly on finalize (no .returning()), and awaits
				 * .returning() on increments. */
				let result: any[] = [];
				if (payload.status) {
					state.finalizeCalls += 1;
				} else if (payload.completedCount !== undefined) {
					state.completed += 1;
					result = [
						{
							id: 1,
							totalCount: state.total,
							completedCount: state.completed,
							failedCount: 0,
						},
					];
				} else if (payload.failedCount !== undefined) {
					result = [
						{
							id: 1,
							totalCount: state.total,
							completedCount: state.completed,
							failedCount: 1,
						},
					];
				}
				return {
					returning: async () => result,
					then: async (resolve: any) => resolve(result),
				};
			},
		}),
	}),
};

vi.mock("@/db/postgres.db", () => ({
	getDb: () => dbChain,
}));

vi.mock("@/services/ai/grading.service", () => ({
	GradingService: {
		getInstance: () => ({
			gradeSubmission: vi.fn(async () => {
				const r = state.suggestionResults.shift() ?? {
					score: 50,
					feedback: "ok",
				};
				return r;
			}),
			recordFailure: vi.fn(async () => {}),
		}),
	},
}));

vi.mock("@/services/engine/grading-pubsub.service", () => ({
	GradingPubSubService: {
		getInstance: () => ({
			publish: vi.fn(async (_batchId: number, event: any) => {
				state.publishCalls.push(event.type);
			}),
		}),
	},
}));

import { GradingWorkerService } from "@/services/workers/grading.worker.service";

describe("GradingWorkerService batch counting", () => {
	beforeEach(() => {
		state.completed = 0;
		state.finalizeCalls = 0;
		state.publishCalls = [];
		state.suggestionResults = [];
	});

	it("finalizes exactly once when N completions run concurrently", async () => {
		const N = 10;
		state.total = N;

		const worker = GradingWorkerService.getInstance();
		await Promise.all(
			Array.from({ length: N }, (_, i) =>
				worker["process"]({
					data: { submissionId: i + 1, batchId: 1 },
				} as any),
			),
		);

		expect(state.completed).toBe(N);
		expect(state.finalizeCalls).toBe(1);
		expect(state.publishCalls.filter((t) => t === "batch-complete").length).toBe(1);
		expect(state.publishCalls.filter((t) => t === "submission-graded").length).toBe(N);
	});

	it("never finalizes when the batch has not reached total", async () => {
		state.total = 5;
		const worker = GradingWorkerService.getInstance();
		await Promise.all(
			Array.from({ length: 3 }, (_, i) =>
				worker["process"]({
					data: { submissionId: i + 1, batchId: 1 },
				} as any),
			),
		);

		expect(state.finalizeCalls).toBe(0);
		expect(state.publishCalls).not.toContain("batch-complete");
	});

	it("marks a no-content submission as failed so the batch can finish", async () => {
		state.total = 1;
		state.suggestionResults.push(null); /* nothing gradeable */
		const worker = GradingWorkerService.getInstance();
		await worker["process"]({
			data: { submissionId: 1, batchId: 1 },
		} as any);

		expect(state.finalizeCalls).toBe(1);
		expect(state.publishCalls.filter((t) => t === "batch-complete").length).toBe(1);
	});
});
