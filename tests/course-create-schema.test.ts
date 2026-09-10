import { describe, expect, it } from "vitest";
import { createCourseFormSchema } from "@/modules/courses/course.schema";

/**
 * @info - The create endpoint accepts multipart FormData, so booleans arrive as
 * strings. These cases pin the two content toggles that the create page sends
 * (`allowComments` / `allowDownloads`): they must be part of the schema's
 * contract rather than undeclared extras, must coerce true strings, and must
 * stay `undefined` when omitted so the model defaults (both `true`) apply.
 */
const base = { communityId: "10", title: "Schema probe" };

describe("createCourseFormSchema — content toggles", () => {
	it("declares allowComments/allowDownloads so a parsed form carries them", () => {
		const parsed = createCourseFormSchema.parse({
			...base,
			allowComments: "false",
			allowDownloads: "false",
		});

		expect(parsed).toHaveProperty("allowComments");
		expect(parsed).toHaveProperty("allowDownloads");
		expect(parsed.allowComments).toBe(false);
		expect(parsed.allowDownloads).toBe(false);
	});

	it("coerces the string forms the create page sends", () => {
		const parsed = createCourseFormSchema.parse({
			...base,
			allowComments: "true",
			allowDownloads: "true",
		});

		expect(parsed.allowComments).toBe(true);
		expect(parsed.allowDownloads).toBe(true);
	});

	it("leaves omitted toggles undefined so model defaults stay authoritative", () => {
		const parsed = createCourseFormSchema.parse(base);

		expect(parsed.allowComments).toBeUndefined();
		expect(parsed.allowDownloads).toBeUndefined();
	});

	it("still coerces the other booleans it shares the helper with", () => {
		const parsed = createCourseFormSchema.parse({
			...base,
			isFree: "false",
			sequentialAccess: "true",
			dripContent: "true",
		});

		expect(parsed.isFree).toBe(false);
		expect(parsed.sequentialAccess).toBe(true);
		expect(parsed.dripContent).toBe(true);
	});
});

/**
 * @info - The create page's pricing card collects a monthly subscription
 * (naira, formatted with commas, sent as kobo like `price`). Declared so the
 * allowlisted create contract keeps it; omitted stays undefined so the column
 * default (null) applies.
 */
describe("createCourseFormSchema — monthlyPrice", () => {
	it("coerces the kobo string the create page sends", () => {
		const parsed = createCourseFormSchema.parse({
			...base,
			monthlyPrice: "4900",
		});

		expect(parsed.monthlyPrice).toBe(4900);
	});

	it("keeps zero as a real value (free monthly option)", () => {
		const parsed = createCourseFormSchema.parse({
			...base,
			monthlyPrice: "0",
		});

		expect(parsed.monthlyPrice).toBe(0);
	});

	it("leaves an omitted monthlyPrice undefined", () => {
		const parsed = createCourseFormSchema.parse(base);

		expect(parsed.monthlyPrice).toBeUndefined();
	});

	it("rejects junk and negative amounts", () => {
		expect(
			createCourseFormSchema.safeParse({ ...base, monthlyPrice: "abc" }).success,
		).toBe(false);
		expect(
			createCourseFormSchema.safeParse({ ...base, monthlyPrice: "-100" }).success,
		).toBe(false);
	});
});
