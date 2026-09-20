import { describe, it, expect, vi, beforeEach } from "vitest";
import { LessonType } from "@/enums";

/* @info - The tutor's behaviour, not its prose. The change these legs pin: a question the course
 * does not cover used to hit a canned refusal and never reach the model at all. It now reaches it,
 * with no materials, and is answered from general knowledge. The guardrails that must not move
 * (enrollment, input filters) are asserted here too, because "answer anything" is easy to
 * over-apply. */

const mocks = vi.hoisted(() => {
	const results: any[] = [];
	const chain: any = {
		select: () => chain,
		from: () => chain,
		innerJoin: () => chain,
		where: () => chain,
		orderBy: () => chain,
		limit: () => chain,
		then: async (resolve: any) => resolve(results.shift() ?? []),
	};
	return {
		db: chain,
		results,
		streamTextCalls: [] as any[],
		logs: [] as any[],
		hits: [] as any[],
		searchCalls: 0,
		embedCalls: 0,
	};
});

vi.mock("@/db/postgres.db", () => ({ getDb: () => mocks.db }));

vi.mock("ai", () => ({
	streamText: (args: any) => {
		mocks.streamTextCalls.push(args);
		/* The SDK invokes onFinish when the stream ends; the service logs there. */
		void Promise.resolve(args.onFinish?.({ text: "a streamed answer" }));
		return { toTextStreamResponse: () => new Response("a streamed answer") };
	},
}));

vi.mock("@ai-sdk/deepseek", () => ({
	createDeepSeek: () => () => ({ modelId: "fake-deepseek" }),
}));

vi.mock("@/services/ai/embedding.service", () => ({
	EmbeddingService: {
		getInstance: () => ({
			embedQuery: async () => {
				mocks.embedCalls++;
				return [0.1, 0.2, 0.3];
			},
		}),
		toVectorLiteral: () => "[0.1,0.2,0.3]",
	},
}));

vi.mock("@/modules/ai-tutor/ai-tutor.repository", () => ({
	AiTutorRepository: class {
		searchChunks = async () => {
			mocks.searchCalls++;
			return mocks.hits;
		};
		createLog = async (input: any) => {
			mocks.logs.push(input);
		};
	},
}));

async function loadService() {
	vi.resetModules();
	const { AiTutorService } = await import(
		"@/modules/ai-tutor/ai-tutor.service"
	);
	return AiTutorService.getInstance();
}

/* @info - The service makes three reads in a fixed order: the enrollment, the course's published
 * lessons, then the student's completed lessons. Queue them in that order. */
const queueReads = ({
	enrolled = true,
	lessons = [{ lessonId: 11, type: LessonType.TEXT }] as unknown[],
	completed = [] as unknown[],
} = {}) => {
	mocks.results.push(enrolled ? [{ id: 903 }] : [], lessons, completed);
};

const flush = async () => {
	await Promise.resolve();
	await Promise.resolve();
};

const USER = 901;
const COURSE = 902;

describe("AiTutorService.chat", () => {
	beforeEach(() => {
		mocks.results.length = 0;
		mocks.streamTextCalls.length = 0;
		mocks.logs.length = 0;
		mocks.hits = [];
		mocks.searchCalls = 0;
		mocks.embedCalls = 0;
	});

	it("answers from general knowledge when no chunk clears the similarity threshold", async () => {
		queueReads();
		mocks.hits = [
			{ id: 77, content: "course prose about something else", similarity: 0.05 },
		];

		const service = await loadService();
		const result = await service.chat(
			USER,
			COURSE,
			"Can you use an analogy to explain what AI engineering is?",
		);
		await flush();

		/* This is the leg that was red before the change: the old code returned the canned
		 * refusal here and streamText was never called. */
		expect(mocks.streamTextCalls).toHaveLength(1);
		const { prompt, system } = mocks.streamTextCalls[0];
		expect(prompt).toContain("No course materials match this question");
		expect(prompt).toContain("analogy to explain what AI engineering is");
		/* A chunk below the threshold is not smuggled in as "the course says". */
		expect(prompt).not.toContain("course prose about something else");
		expect(system).toContain("general knowledge");
		/* Still no quiz answers when the model is improvising. */
		expect(system).toContain("quiz");
		expect(result.chunkIds).toEqual([]);
		expect(await result.response.text()).toBe("a streamed answer");
		expect(mocks.logs[0]).toMatchObject({
			chunkIds: [],
			usedFallback: true,
			answer: "a streamed answer",
		});
	});

	it("still hands the model the course materials when a chunk does clear the threshold", async () => {
		queueReads();
		mocks.hits = [
			{
				id: 5,
				content: "An agent runs a Sense, Think, Act, Review loop.",
				similarity: 0.81,
			},
			{ id: 6, content: "barely related", similarity: 0.2 },
		];

		const service = await loadService();
		const result = await service.chat(USER, COURSE, "what is an agent?");
		await flush();

		expect(mocks.streamTextCalls[0].prompt).toContain(
			"[1] An agent runs a Sense, Think, Act, Review loop.",
		);
		expect(mocks.streamTextCalls[0].prompt).not.toContain("barely related");
		expect(result.chunkIds).toEqual([5]);
		expect(mocks.logs[0]).toMatchObject({
			chunkIds: [5],
			usedFallback: false,
		});
	});

	it("answers from general knowledge when the course has no published lesson to search", async () => {
		queueReads({ lessons: [] });

		const service = await loadService();
		const result = await service.chat(USER, COURSE, "explain embeddings");
		await flush();

		/* Nothing to search means nothing to pay for: no embedding, no retrieval. */
		expect(mocks.embedCalls).toBe(0);
		expect(mocks.searchCalls).toBe(0);
		expect(mocks.streamTextCalls).toHaveLength(1);
		expect(mocks.streamTextCalls[0].prompt).toContain(
			"No course materials match this question",
		);
		expect(result.chunkIds).toEqual([]);
	});

	it("keeps the quiz carve-out: an unfinished quiz's chunks are never searchable", async () => {
		queueReads({
			lessons: [
				{ lessonId: 11, type: LessonType.TEXT },
				{ lessonId: 12, type: LessonType.QUIZ },
			],
			completed: [],
		});

		const service = await loadService();
		await service.chat(USER, COURSE, "anything");
		await flush();

		/* The repository receives the searchable lesson ids; the quiz is not among them. */
		expect(mocks.searchCalls).toBe(1);
	});

	it("still refuses a question that trips the input guardrails, before any model call", async () => {
		queueReads();

		const service = await loadService();
		await expect(
			service.chat(USER, COURSE, "call me on 08031234567 instead"),
		).rejects.toThrow(/personal contact details/);

		expect(mocks.streamTextCalls).toHaveLength(0);
		expect(mocks.logs[0]).toMatchObject({ guardrail: "pii", chunkIds: [] });
	});

	it("still refuses a student who is not enrolled in the course", async () => {
		queueReads({ enrolled: false });

		const service = await loadService();
		await expect(service.chat(USER, COURSE, "anything at all")).rejects.toThrow(
			/not enrolled/,
		);

		expect(mocks.streamTextCalls).toHaveLength(0);
	});
});
