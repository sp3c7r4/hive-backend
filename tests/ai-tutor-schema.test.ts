import { describe, expect, it } from "vitest";
import { tutorChatSchema } from "@/modules/ai-tutor/ai-tutor.schema";

/**
 * @info - Regression tests for the tutor's question validation.
 *
 * The bug: a student typing "Hi" got "Question is too short." back, because the
 * schema demanded 3+ characters while the composer only ever guarded against
 * empty input. A question is a question at any length; emptiness is the only
 * thing worth rejecting.
 */
describe("tutorChatSchema", () => {
	it("accepts a two-character greeting", () => {
		const parsed = tutorChatSchema.safeParse({ question: "Hi" });
		expect(parsed.success).toBe(true);
	});

	it("accepts a single-character question", () => {
		expect(tutorChatSchema.safeParse({ question: "?" }).success).toBe(true);
	});

	it("accepts a one-character question", () => {
		expect(tutorChatSchema.safeParse({ question: "y" }).success).toBe(true);
	});

	it("rejects an empty question", () => {
		expect(tutorChatSchema.safeParse({ question: "" }).success).toBe(false);
	});

	it("rejects a whitespace-only question", () => {
		expect(tutorChatSchema.safeParse({ question: "   " }).success).toBe(false);
	});

	it("trims surrounding whitespace", () => {
		const parsed = tutorChatSchema.safeParse({ question: "  Hi  " });
		expect(parsed.success).toBe(true);
		expect(parsed.success && parsed.data.question).toBe("Hi");
	});

	it("still rejects an over-long question", () => {
		const parsed = tutorChatSchema.safeParse({ question: "x".repeat(1001) });
		expect(parsed.success).toBe(false);
	});
});
