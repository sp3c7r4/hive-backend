import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/postgres.db";
import { notifications, type NewNotification } from "./notification.model";
import { user_roles } from "@/modules/user/user-role.model";
import { serviceLogger } from "@/utils";
import { ChatPubSubService } from "@/services/engine/chat-pubsub.service";
import { NotificationType } from "@/enums";

/** @info - User notifications: created by other modules (messaging, feed,
 * certificates, withdrawals, reviews) via notify(); read via the API. */
export class NotificationService {
	private static instance: NotificationService;
	private readonly log = serviceLogger("Notifications");

	static getInstance(): NotificationService {
		if (!this.instance) this.instance = new NotificationService();
		return this.instance;
	}

	private constructor() {}

	/** @info - Fire-and-forget create. Resolves the recipient's primary role
	 * for the role column; failures are logged, never thrown to the caller. */
	notify = async (
		userId: number,
		type: NotificationType,
		title: string,
		message: string,
		metadata?: Record<string, unknown>,
	): Promise<void> => {
		try {
			const db = getDb();
			const [roleRow] = await db
				.select({ role: user_roles.role })
				.from(user_roles)
				.where(eq(user_roles.userId, userId))
				.limit(1);

			const data: NewNotification = {
				userId,
				role: (roleRow?.role as any) ?? "student",
				type: type as any,
				title,
				message,
				metadata: (metadata ?? {}) as any,
			};
			const [row] = (await db
				.insert(notifications)
				.values(data as any)
				.returning()) as any[];

			/* @info - Realtime push: same Redis channel + envelope as chat,
			 * so any open socket delivers it instantly (30s poll is the fallback). */
			if (row) {
				await ChatPubSubService.getInstance().publishUser(userId, {
					timestamp: new Date().toISOString(),
					status: 200,
					success: true,
					data: {
						type: "notification:new",
						payload: {
							id: row.id,
							type: row.type,
							title: row.title,
							message: row.message,
							metadata: row.metadata ?? {},
							read: false,
							createdAt: row.createdAt,
						},
					},
				});
			}
		} catch (error) {
			this.log.error(`Failed to notify user ${userId}: ${(error as Error).message}`);
		}
	};

	listMine = async (userId: number, params?: { page?: number; limit?: number }) => {
		const db = getDb();
		const page = Math.max(1, params?.page ?? 1);
		const limit = Math.min(50, Math.max(1, params?.limit ?? 20));

		const [rows, totalRows] = await Promise.all([
			db
				.select()
				.from(notifications)
				.where(eq(notifications.userId, userId))
				.orderBy(desc(notifications.createdAt))
				.limit(limit)
				.offset((page - 1) * limit) as any,
			db
				.select({ total: notifications.id })
				.from(notifications)
				.where(eq(notifications.userId, userId)) as any,
		]);

		return {
			data: (rows as any[]).map((n) => ({
				id: n.id,
				type: n.type,
				title: n.title,
				message: n.message,
				metadata: n.metadata ?? {},
				read: !!n.readAt,
				createdAt: n.createdAt,
			})),
			total: totalRows.length,
			page,
			limit,
		};
	};

	unreadCount = async (userId: number) => {
		const db = getDb();
		const rows = (await db
			.select({ id: notifications.id })
			.from(notifications)
			.where(
				and(eq(notifications.userId, userId), isNull(notifications.readAt)),
			)) as any[];
		return rows.length;
	};

	markRead = async (userId: number, id: number) => {
		const db = getDb();
		const [row] = (await db
			.update(notifications)
			.set({ readAt: new Date() })
			.where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
			.returning()) as any[];
		return !!row;
	};

	markAllRead = async (userId: number) => {
		const db = getDb();
		await db
			.update(notifications)
			.set({ readAt: new Date() })
			.where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
	};
}
