import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPostgresDB, getDb } from "@/db/postgres.db";
import { JwtAction, UserTypes } from "@/enums";
import { BadRequestError, ForbiddenError, NotFoundError } from "@/errors";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { CommunityService } from "@/modules/communities/community.service";
import { CourseService } from "@/modules/courses/course.service";
import { CacheService, JwtService } from "@/services";
import { testApp } from "./setup";

/**
 * @info - Course → community move (PATCH /courses/:id/community). The move has
 * its own endpoint precisely because the general update allowlist strips
 * communityId (mass-assignment), so this suite pins both halves of that deal:
 * the move changes that one column and the counter that follows it, and the
 * general PATCH still refuses to change the column at all.
 *
 * Runs against the real database, like the calendar and live suites, because
 * every guarantee here is about rows: the course actually moves, the
 * communities' course_count follows it, an enrolment/curriculum survives
 * untouched, and the publish-target rule agrees with the scope=mine listing the
 * create UI offers.
 */
describe("course → community move", () => {
	const service = CourseService.getInstance();
	const communityService = CommunityService.getInstance();
	let db: ReturnType<typeof getDb>;

	const stamp = Date.now();
	const auth = (id: number, roles: string[] = ["instructor"]) =>
		({ id, roles, email: `move-${id}@test.local` }) as unknown as IAuthData;

	let me: number;
	let other: number;
	let student: number;
	let admin: number;
	let ownedCommunity: number;
	let memberCommunity: number;
	let pendingCommunity: number;
	let foreignCommunity: number;
	let removedCommunity: number;
	let otherArchivedCommunity: number;
	let ownedArchivedCommunity: number;
	let courseMain: number;
	let courseData: number;
	let courseStranger: number;
	let courseForeign: number;
	let coursePending: number;
	let courseRemoved: number;
	let courseArchived: number;
	let courseAdmin: number;
	let courseIdempotent: number;
	let courseMassAssign: number;
	let courseRoute: number;

	const createCourse = async (communityId: number, tag: string) => {
		const r = await db.execute(
			`INSERT INTO courses (instructor_id, community_id, title, slug, status, category, price)
			 VALUES (${me}, ${communityId}, 'Move ${tag}', 'move-${tag}-${stamp}', 'draft', 'test', 0)
			 RETURNING id`,
		);
		return (r.rows[0] as { id: number }).id;
	};

	/** @info - The two facts a move has to keep true, read straight from the rows. */
	const courseCommunityId = async (courseId: number) => {
		const r = await db.execute(
			`SELECT community_id FROM courses WHERE id = ${courseId}`,
		);
		return (r.rows[0] as { community_id: number | null }).community_id;
	};
	const courseCountOf = async (communityId: number) => {
		const r = await db.execute(
			`SELECT course_count FROM communities WHERE id = ${communityId}`,
		);
		return Number((r.rows[0] as { course_count: number }).course_count);
	};

	beforeAll(async () => {
		await connectPostgresDB(() => {});
		db = getDb();

		const makeUser = async (tag: string) => {
			const r = await db.execute(
				`INSERT INTO users (first_name, last_name, email, email_verified, onboarded)
				 VALUES ('Move', 'Test', 'move-${tag}-${stamp}@test.local', true, true) RETURNING id`,
			);
			return (r.rows[0] as { id: number }).id;
		};

		me = await makeUser("me");
		other = await makeUser("other");
		student = await makeUser("student");
		admin = await makeUser("admin");

		const makeCommunity = async (
			ownerId: number,
			tag: string,
			courseCount = 0,
			deleted = false,
		) => {
			const r = await db.execute(
				`INSERT INTO communities (owner_id, name, slug, course_count, deleted_at)
				 VALUES (${ownerId}, 'Move ${tag}', 'move-comm-${tag}-${stamp}', ${courseCount}, ${deleted ? "now()" : "null"})
				 RETURNING id`,
			);
			return (r.rows[0] as { id: number }).id;
		};
		const addMember = async (
			communityId: number,
			userId: number,
			status = "active",
			memberRole = "member",
			role = "instructor",
		) => {
			await db.execute(
				`INSERT INTO community_members (community_id, user_id, status, member_role, role)
				 VALUES (${communityId}, ${userId}, '${status}', '${memberRole}', '${role}')`,
			);
		};

		/* The caller owns this one; course_count is seeded so the move's effect is visible. */
		ownedCommunity = await makeCommunity(me, "owned", 3);

		/* An admin of the community the course is leaving — the takeover primitive. */
		await addMember(ownedCommunity, other, "active", "admin");

		/* A community the caller may publish into: active member, not owner. */
		memberCommunity = await makeCommunity(other, "member", 5);
		await addMember(memberCommunity, me);

		/* Same rule, two states the listing and the endpoint must agree about. */
		pendingCommunity = await makeCommunity(other, "pending", 0);
		await addMember(pendingCommunity, me, "pending");
		foreignCommunity = await makeCommunity(other, "foreign", 0);

		/* Active membership now, removed inside its test. */
		removedCommunity = await makeCommunity(other, "removed", 0);
		await addMember(removedCommunity, me);

		/* Archived targets: someone else's, and the caller's own (the listing keeps
		 * an owner's archived communities, publishing into one is still refused). */
		otherArchivedCommunity = await makeCommunity(other, "archived", 0, true);
		ownedArchivedCommunity = await makeCommunity(me, "ownedarchived", 0, true);

		courseMain = await createCourse(ownedCommunity, "main");
		courseStranger = await createCourse(ownedCommunity, "stranger");
		courseForeign = await createCourse(ownedCommunity, "foreign");
		coursePending = await createCourse(ownedCommunity, "pending");
		courseRemoved = await createCourse(ownedCommunity, "removed");
		courseArchived = await createCourse(ownedCommunity, "archived");
		courseAdmin = await createCourse(ownedCommunity, "admin");
		courseMassAssign = await createCourse(ownedCommunity, "massassign");
		courseIdempotent = await createCourse(memberCommunity, "idempotent");
		courseRoute = await createCourse(ownedCommunity, "route");

		/* The route test goes through requireInstructor, which reads user_roles, and
		 * through validateToken, which resolves the session from the cache. */
		await db.execute(
			`INSERT INTO user_roles (user_id, role) VALUES (${me}, 'instructor')`,
		);
		const cache = CacheService.getInstance();
		for (const [userId, roles] of [
			[me, ["instructor"]],
			[student, ["student"]],
		] as [number, string[]][]) {
			await cache.set(String(userId), {
				id: userId,
				authId: String(userId),
				action: JwtAction.AUTHENTICATE,
				userType: UserTypes.USER,
				roles,
				emailVerified: true,
				isAuthenticated: true,
			});
		}

		/* A course carrying an enrolment and a lesson, so the move can be shown to
		 * leave both intact. */
		courseData = await createCourse(ownedCommunity, "data");
		const mod = await db.execute(
			`INSERT INTO modules (course_id, title, sort_order)
			 VALUES (${courseData}, 'Move Module', 1) RETURNING id`,
		);
		const moduleId = (mod.rows[0] as { id: number }).id;
		await db.execute(
			`INSERT INTO lessons (module_id, title, sort_order)
			 VALUES (${moduleId}, 'Move Lesson', 1)`,
		);
		await db.execute(
			`INSERT INTO enrollments (user_id, course_id) VALUES (${student}, ${courseData})`,
		);
	});

	afterAll(async () => {
		/* Scoped by this run's stamp so no dev data is touched. */
		const coursesOfRun = `SELECT id FROM courses WHERE slug LIKE 'move-%-${stamp}%'`;
		await db.execute(
			`DELETE FROM lessons WHERE module_id IN (SELECT id FROM modules WHERE course_id IN (${coursesOfRun}))`,
		);
		await db.execute(
			`DELETE FROM modules WHERE course_id IN (${coursesOfRun})`,
		);
		await db.execute(
			`DELETE FROM enrollments WHERE course_id IN (${coursesOfRun})`,
		);
		await db.execute(`DELETE FROM courses WHERE slug LIKE 'move-%-${stamp}%'`);
		await db.execute(
			`DELETE FROM community_members WHERE community_id IN (SELECT id FROM communities WHERE slug LIKE 'move-comm-%-${stamp}')`,
		);
		await db.execute(
			`DELETE FROM communities WHERE slug LIKE 'move-comm-%-${stamp}'`,
		);
		await db.execute(
			`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'move-%-${stamp}@test.local')`,
		);
		await db.execute(
			`DELETE FROM users WHERE email LIKE 'move-%-${stamp}@test.local'`,
		);
		const cache = CacheService.getInstance();
		await cache.delete(String(me));
		await cache.delete(String(student));
	});

	it("moves the course and follows both communities' course counts", async () => {
		const ownedBefore = await courseCountOf(ownedCommunity);
		const memberBefore = await courseCountOf(memberCommunity);

		const result = await service.moveCourseCommunity(
			auth(me),
			courseMain,
			memberCommunity,
		);

		expect(result.communityId).toBe(memberCommunity);
		expect(await courseCommunityId(courseMain)).toBe(memberCommunity);
		expect(await courseCountOf(ownedCommunity)).toBe(ownedBefore - 1);
		expect(await courseCountOf(memberCommunity)).toBe(memberBefore + 1);
	});

	it("leaves the enrolment and the curriculum intact", async () => {
		await service.moveCourseCommunity(auth(me), courseData, memberCommunity);

		const enrolment = await db.execute(
			`SELECT id FROM enrollments WHERE user_id = ${student} AND course_id = ${courseData}`,
		);
		expect(enrolment.rows).toHaveLength(1);

		const lessons = await db.execute(
			`SELECT l.id FROM lessons l
			 JOIN modules m ON m.id = l.module_id
			 WHERE m.course_id = ${courseData}`,
		);
		expect(lessons.rows).toHaveLength(1);

		const modules = await db.execute(
			`SELECT id FROM modules WHERE course_id = ${courseData}`,
		);
		expect(modules.rows).toHaveLength(1);
	});

	it("403 for an admin of the community the course is leaving, who is not its owner", async () => {
		await expect(
			service.moveCourseCommunity(auth(other), courseStranger, memberCommunity),
		).rejects.toThrow(ForbiddenError);
		expect(await courseCommunityId(courseStranger)).toBe(ownedCommunity);
	});

	it("403 when the target community is one the caller cannot publish into", async () => {
		await expect(
			service.moveCourseCommunity(auth(me), courseForeign, foreignCommunity),
		).rejects.toThrow(ForbiddenError);
		expect(await courseCommunityId(courseForeign)).toBe(ownedCommunity);
	});

	it("403 for a pending membership — the same set the scope=mine listing offers", async () => {
		await expect(
			service.moveCourseCommunity(auth(me), coursePending, pendingCommunity),
		).rejects.toThrow(ForbiddenError);
		expect(await courseCommunityId(coursePending)).toBe(ownedCommunity);
	});

	it("403 once the caller's membership is removed", async () => {
		await db.execute(
			`DELETE FROM community_members
			 WHERE community_id = ${removedCommunity} AND user_id = ${me}`,
		);
		await expect(
			service.moveCourseCommunity(auth(me), courseRemoved, removedCommunity),
		).rejects.toThrow(ForbiddenError);
		expect(await courseCommunityId(courseRemoved)).toBe(ownedCommunity);
	});

	it("404 for an unknown target community", async () => {
		await expect(
			service.moveCourseCommunity(auth(me), courseArchived, 999999999),
		).rejects.toThrow(NotFoundError);
		expect(await courseCommunityId(courseArchived)).toBe(ownedCommunity);
	});

	it("404 for an archived target, including the caller's own archived community", async () => {
		await expect(
			service.moveCourseCommunity(auth(me), courseArchived, otherArchivedCommunity),
		).rejects.toThrow(NotFoundError);
		await expect(
			service.moveCourseCommunity(auth(me), courseArchived, ownedArchivedCommunity),
		).rejects.toThrow(NotFoundError);
		expect(await courseCommunityId(courseArchived)).toBe(ownedCommunity);
	});

	it("404 for an unknown course", async () => {
		await expect(
			service.moveCourseCommunity(auth(me), 999999999, memberCommunity),
		).rejects.toThrow(NotFoundError);
	});

	it("400 for a community id that is not a positive integer", async () => {
		await expect(
			service.moveCourseCommunity(auth(me), courseMain, Number("junk")),
		).rejects.toThrow(BadRequestError);
		await expect(
			service.moveCourseCommunity(auth(me), courseMain, 0),
		).rejects.toThrow(BadRequestError);
	});

	it("is idempotent when the course already lives in the target", async () => {
		const memberBefore = await courseCountOf(memberCommunity);
		const ownedBefore = await courseCountOf(ownedCommunity);

		const result = await service.moveCourseCommunity(
			auth(me),
			courseIdempotent,
			memberCommunity,
		);

		expect(result.communityId).toBe(memberCommunity);
		expect(await courseCommunityId(courseIdempotent)).toBe(memberCommunity);
		expect(await courseCountOf(memberCommunity)).toBe(memberBefore);
		expect(await courseCountOf(ownedCommunity)).toBe(ownedBefore);
	});

	it("lets a platform admin move into a community they are not a member of", async () => {
		const result = await service.moveCourseCommunity(
			auth(admin, ["instructor", "admin"]),
			courseAdmin,
			foreignCommunity,
		);
		expect(result.communityId).toBe(foreignCommunity);
		expect(await courseCommunityId(courseAdmin)).toBe(foreignCommunity);
	});

	it("refuses to create a course into a community the author has no standing in", async () => {
		await expect(
			service.createCourse(auth(me), {
				communityId: foreignCommunity,
				title: `Move Created ${stamp}`,
			} as any),
		).rejects.toThrow(ForbiddenError);

		const created = await db.execute(
			`SELECT id FROM courses WHERE slug LIKE 'move-created-${stamp}%'`,
		);
		expect(created.rows).toHaveLength(0);
	});

	it("still creates into a community where the author is an active member", async () => {
		const before = await courseCountOf(memberCommunity);

		const created = await service.createCourse(auth(me), {
			communityId: memberCommunity,
			title: `Move Created ${stamp}`,
		} as any);

		expect(created.communityId).toBe(memberCommunity);
		expect(await courseCountOf(memberCommunity)).toBe(before + 1);
	});

	it("the general course update still ignores communityId (mass-assignment stays closed)", async () => {
		const updated = await service.updateCourse(auth(me), courseMassAssign, {
			communityId: foreignCommunity,
			title: "Move Retitled",
		} as any);

		expect(updated.title).toBe("Move Retitled");
		expect(await courseCommunityId(courseMassAssign)).toBe(ownedCommunity);
	});

	it("agrees with the scope=mine listing about who may publish where", async () => {
		const listed = await communityService.list({
			scope: "mine",
			userId: me,
			limit: 50,
		});
		const ids = listed.data.map((c: any) => c.id);

		/* Owned, actively joined, and the owner's own archived one (still listed). */
		expect(ids).toContain(ownedCommunity);
		expect(ids).toContain(memberCommunity);
		expect(ids).toContain(ownedArchivedCommunity);

		/* Never offered as a target — and refused by the endpoint above. */
		expect(ids).not.toContain(foreignCommunity);
		expect(ids).not.toContain(pendingCommunity);
		expect(ids).not.toContain(otherArchivedCommunity);
	});

	/* @info - Route wiring: the untested middle (JWT -> requireInstructor -> body
	 * validation -> controller -> service) is where an endpoint silently fails to
	 * exist, so one request per outcome goes over real HTTP. */
	describe("PATCH /api/v1/courses/:id/community", () => {
		const patch = async (
			courseId: number | string,
			body: unknown,
			token?: string,
		) =>
			testApp.request(`/api/v1/courses/${courseId}/community`, {
				method: "PATCH",
				body: JSON.stringify(body),
				headers: {
					"Content-Type": "application/json",
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
			});

		it("401 without a token — the route exists and is guarded", async () => {
			const res = await patch(courseRoute, { communityId: memberCommunity });
			expect(res.status).toBe(401);
		});

		it("403 for a signed-in user who does not hold the instructor role", async () => {
			const res = await patch(
				courseRoute,
				{ communityId: memberCommunity },
				JwtService.getInstance().generateToken(String(student)),
			);
			expect(res.status).toBe(403);
		});

		it("400 for a body without a positive communityId", async () => {
			const res = await patch(
				courseRoute,
				{ communityId: "junk" },
				JwtService.getInstance().generateToken(String(me)),
			);
			expect(res.status).toBe(400);
		});

		it("200 and the course moves, end to end", async () => {
			const res = await patch(
				courseRoute,
				{ communityId: memberCommunity },
				JwtService.getInstance().generateToken(String(me)),
			);
			expect(res.status).toBe(200);
			/* The envelope is { data: { message, data } } — the same shape the
			 * update route returns, so the client's existing unwrapping applies. */
			const body = (await res.json()) as {
				data: { message: string; data: { communityId: number } };
			};
			expect(body.data.message).toBe("Course moved successfully");
			expect(body.data.data.communityId).toBe(memberCommunity);
			expect(await courseCommunityId(courseRoute)).toBe(memberCommunity);
		});

		it("the general update route still ignores communityId", async () => {
			const res = await testApp.request(`/api/v1/courses/${courseRoute}`, {
				method: "PATCH",
				body: JSON.stringify({
					communityId: foreignCommunity,
					title: "Move Route Retitled",
				}),
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${JwtService.getInstance().generateToken(String(me))}`,
				},
			});
			expect(res.status).toBe(200);
			const row = await db.execute(
				`SELECT community_id, title FROM courses WHERE id = ${courseRoute}`,
			);
			expect(
				(row.rows[0] as { community_id: number }).community_id,
			).toBe(memberCommunity);
			expect((row.rows[0] as { title: string }).title).toBe("Move Route Retitled");
		});
	});
});
