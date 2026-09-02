import { hash } from "@node-rs/argon2";
import { beforeAll, describe, expect, it } from "vitest";
import { TTL } from "@/constants";
import { connectPostgresDB, getDb } from "@/db/postgres.db";
import { generateOTPId } from "@/helpers/id-generators";
import { AuthService } from "@/modules/auth/auth.service";
import { CacheService, EncryptionService } from "@/services";

/**
 * @info - Origin-locked login guards: OAuth-created accounts can only sign in
 * via the provider; password/OTP accounts can never sign in via OAuth.
 * Creates real rows and cleans them up.
 */
describe("Origin-locked login guards", () => {
	const service = AuthService.getInstance();
	const cache = CacheService.getInstance();
	const encryption = EncryptionService.getInstance();
	let db: ReturnType<typeof getDb>;

	const stamp = Date.now();
	const passwordEmail = `guard-pass-${stamp}@test.local`;
	const oauthEmail = `guard-oauth-${stamp}@test.local`;
	let passwordUserId: number;
	let oauthUserId: number;

	beforeAll(async () => {
		await connectPostgresDB(() => {});
		db = getDb();
	});

	it("password login works on a password account", async () => {
		const ph = await hash("TestPass123!", {
			memoryCost: 65536,
			parallelism: 1,
			timeCost: 1,
		});
		const ins = await db.execute(
			`INSERT INTO users (first_name, last_name, email, password_hash, email_verified, onboarded)
			 VALUES ('Guard', 'Pass', '${passwordEmail}', '${ph}', true, true) RETURNING id`,
		);
		passwordUserId = (ins.rows[0] as { id: number }).id;

		const res = await service.login({
			email: passwordEmail,
			password: "TestPass123!",
			loginType: "password",
		} as any);
		expect((res as any).message).toBe("Login successful");
	});

	it("password login on an OAuth account throws with the provider name", async () => {
		const u = await db.execute(
			`INSERT INTO users (first_name, last_name, email, onboarded)
			 VALUES ('Guard', 'OAuth', '${oauthEmail}', true) RETURNING id`,
		);
		oauthUserId = (u.rows[0] as { id: number }).id;

		await db.execute(
			`INSERT INTO user_credentials (user_id, role, provider, provider_account_id)
			 VALUES (${oauthUserId}, 'student', 'google', 'g-${oauthUserId}')`,
		);

		await expect(
			service.login({
				email: oauthEmail,
				password: "whatever",
				loginType: "password",
			} as any),
		).rejects.toThrow(/uses Google to sign in/);
	});

	it("OTP login request on an OAuth account throws with the provider name", async () => {
		await expect(
			service.login({
				email: oauthEmail,
				password: undefined,
				loginType: "otp",
			} as any),
		).rejects.toThrow(/uses Google to sign in/);
	});

	it("OTP login request on a password account sends a code", async () => {
		const res = await service.login({
			email: passwordEmail,
			password: undefined,
			loginType: "otp",
		} as any);
		expect((res as any).token).toBeTruthy();
	});

	it("OTP completion (AUTHENTICATE) on an OAuth account is blocked", async () => {
		const otpId = generateOTPId();
		const otp = "000000";
		await cache.set(otpId, { otp: encryption.encrypt(otp) }, TTL.IN_30_MINUTES);

		const authData = {
			authId: `auth:${oauthUserId}-guard-test`,
			otpId,
			email: oauthEmail,
			firstName: "Guard",
			lastName: "OAuth",
			action: "authenticate",
			userType: "student",
		};

		await expect(service.verifyEmail(authData as any, otp)).rejects.toThrow(
			/uses Google to sign in/,
		);
	});

	it("OTP completion on a password account succeeds", async () => {
		const otpId = generateOTPId();
		const otp = "111111";
		await cache.set(otpId, { otp: encryption.encrypt(otp) }, TTL.IN_30_MINUTES);

		const authData = {
			authId: `auth:${passwordUserId}-guard-test-2`,
			otpId,
			email: passwordEmail,
			firstName: "Guard",
			lastName: "Pass",
			action: "authenticate",
			userType: "student",
		};

		const result = await service.verifyEmail(authData as any, otp);
		expect(result).toBeTruthy();
	});

	/* cleanup */
	it("cleans up test rows", async () => {
		await db.execute(
			`DELETE FROM user_credentials WHERE user_id IN (${passwordUserId}, ${oauthUserId})`,
		);
		await db.execute(
			`DELETE FROM users WHERE id IN (${passwordUserId}, ${oauthUserId})`,
		);
		expect(true).toBe(true);
	});
});
