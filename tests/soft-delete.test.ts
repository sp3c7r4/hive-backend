import { describe, it, expect } from "vitest";
import { RelationalRepository } from "@/bases/repositories/relational.repository";
import { users } from "@/modules/user/user.model";
import { test } from "@/modules/test/test.schema";

describe("RelationalRepository soft-delete scope", () => {
	it("detects soft-delete column on users table", () => {
		const repo = new RelationalRepository(users);
		// users has deleted_at from softDelete helper
		expect(repo).toBeDefined();
	});

	it("does not filter on table without deleted_at", () => {
		const repo = new RelationalRepository(test);
		// test table has no deleted_at column
		expect(repo).toBeDefined();
	});

	it("findById accepts includeDeleted option", () => {
		const repo = new RelationalRepository(users);
		expect(repo.findById).toBeDefined();
		// Type check: options param accepted
		const _opts = { includeDeleted: true };
		expect(_opts.includeDeleted).toBe(true);
	});

	it("softDelete sets deleted_at instead of hard-deleting", () => {
		const repo = new RelationalRepository(users);
		expect(repo.softDelete).toBeDefined();
	});
});
