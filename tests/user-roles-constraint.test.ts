import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { config } from "@/config";
import { connectPostgresDB, getDb } from "@/db/postgres.db";
import { users } from "@/modules/user/user.model";

/**
 * @info - Policy: a user holds at most ONE working role (student|instructor|parent);
 * 'admin' is exempt so platform staff can also teach or study. Enforced by the
 * partial unique index uq_user_role_single_working (migration 0027). Expects a
 * migrated database (npm run migrate).
 */
describe("user_roles — single working role invariant", () => {
	let db: ReturnType<typeof getDb>;
	let pool: Pool;
	let userId: number;

	const email = `role-constraint-${Date.now()}@hive.test`;

	const addRole = (role: string) =>
		pool.query("INSERT INTO user_roles (user_id, role) VALUES ($1, $2::user_role)", [
			userId,
			role,
		]);
	const roleCount = async () =>
		Number(
			(
				await pool.query(
					"SELECT count(*)::int AS c FROM user_roles WHERE user_id = $1",
					[userId],
				)
			).rows[0].c,
		);

	beforeAll(async () => {
		await connectPostgresDB(() => {});
		db = getDb();
		pool = new Pool({ connectionString: config.db.uri });
		const [row] = await db
			.insert(users)
			.values({ firstName: "Role", lastName: "Probe", email } as any)
			.returning({ id: users.id });
		userId = row!.id;
	});

	afterAll(async () => {
		/* user_roles → users is ON DELETE CASCADE */
		await db.delete(users).where(eq(users.email, email));
		await pool.end().catch(() => {});
	});

	it("accepts the first working role", async () => {
		await addRole("instructor");
		expect(await roleCount()).toBe(1);
	});

	it("rejects a second, different working role", async () => {
		await expect(addRole("student")).rejects.toThrow(
			/uq_user_role_single_working|duplicate key/i,
		);
		expect(await roleCount()).toBe(1);
	});

	it("allows admin alongside a working role", async () => {
		await addRole("admin");
		expect(await roleCount()).toBe(2);
	});

	it("still rejects another working role when admin is present", async () => {
		await expect(addRole("parent")).rejects.toThrow(
			/uq_user_role_single_working|duplicate key/i,
		);
		expect(await roleCount()).toBe(2);
	});

	it("rejects a duplicate admin row (pair uniqueness still holds)", async () => {
		await expect(addRole("admin")).rejects.toThrow(/uq_user_role|duplicate key/i);
		expect(await roleCount()).toBe(2);
	});
});
