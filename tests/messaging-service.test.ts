import { describe, it, expect, vi, beforeEach } from "vitest";

/* Mocks — same pattern as submission-service.test.ts: setup.ts pre-loads the
 * route graph, so we reset modules and load the service fresh per test. */
const mocks = vi.hoisted(() => {
	const repo = {
		findDirectBetween: vi.fn(),
		createDirect: vi.fn(),
		listForUser: vi.fn(),
		listMessages: vi.fn(),
		findMessage: vi.fn(),
		insertMessage: vi.fn(),
		isParticipant: vi.fn(),
		markRead: vi.fn(),
		getPrimaryRole: vi.fn(),
		softDeleteMessage: vi.fn(),
		getPeerId: vi.fn(),
		getParticipantIds: vi.fn(),
	};
	const userRow = { id: 5, firstName: "Peer", lastName: "User", email: "peer@hive.test" };
	const queryChain = { limit: vi.fn(async () => [userRow]) };
	const db = {
		select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => queryChain) })) })),
	};
	const publishUser = vi.fn();
	const redis = {
		incr: vi.fn(async () => 1),
		expire: vi.fn(async () => 1),
	};
	return { repo, db, publishUser, redis };
});

vi.mock("@/modules/messaging/messaging.repository", () => ({
	MessagingRepository: { getInstance: () => mocks.repo },
}));
vi.mock("@/db/postgres.db", () => ({ getDb: () => mocks.db }));
vi.mock("@/services/engine/chat-pubsub.service", () => ({
	ChatPubSubService: {
		getInstance: () => ({ publishUser: mocks.publishUser }),
	},
}));
vi.mock("@/services/cache.service", () => ({
	CacheService: {
		getInstance: () => ({
			getRedisClient: () => mocks.redis,
		}),
	},
}));

async function loadService() {
	vi.resetModules();
	const { MessagingService } = await import("@/modules/messaging/messaging.service");
	return MessagingService.getInstance();
}

const auth = { id: 6, roles: ["student"] } as any;

const convRow = {
	id: 1,
	type: "direct",
	title: null,
	lastMessageAt: new Date(),
	createdAt: new Date(),
	myLastReadAt: null,
	peerId: 5,
	peerFirstName: "Peer",
	peerLastName: "User",
	peerEmail: "peer@hive.test",
	peerAvatarUrl: null,
	lastMessage: null,
	unreadCount: 0,
};

describe("MessagingService.createConversation", () => {
	beforeEach(() => {
		mocks.repo.findDirectBetween.mockReset();
		mocks.repo.createDirect.mockReset();
		mocks.repo.listForUser.mockReset();
		mocks.repo.getPrimaryRole.mockReset();
	});

	it("rejects messaging yourself", async () => {
		const service = await loadService();
		await expect(service.createConversation(auth, 6)).rejects.toThrow(
			"You cannot message yourself",
		);
	});

	it("is idempotent — returns the existing conversation for the same pair", async () => {
		const service = await loadService();
		mocks.repo.findDirectBetween.mockResolvedValue({ id: 1 });
		mocks.repo.listForUser.mockResolvedValue([convRow]);

		const result = await service.createConversation(auth, 5);
		expect(result.id).toBe(1);
		expect(mocks.repo.createDirect).not.toHaveBeenCalled();
	});

	it("creates a new conversation with both users' primary roles", async () => {
		const service = await loadService();
		mocks.repo.findDirectBetween.mockResolvedValue(null);
		mocks.repo.getPrimaryRole.mockImplementation(async (id: number) =>
			id === 6 ? "student" : "instructor",
		);
		mocks.repo.createDirect.mockResolvedValue({ id: 7 });
		mocks.repo.listForUser.mockResolvedValue([{ ...convRow, id: 7, peerId: 5 }]);

		const result = await service.createConversation(auth, 5);
		expect(mocks.repo.createDirect).toHaveBeenCalledWith(6, "student", 5, "instructor");
		expect(result.id).toBe(7);
	});
});

describe("MessagingService.send", () => {
	beforeEach(() => {
		mocks.repo.findDirectBetween.mockReset();
		mocks.repo.createDirect.mockReset();
		mocks.repo.insertMessage.mockReset();
		mocks.repo.getPrimaryRole.mockReset();
		mocks.repo.findDirectBetween.mockResolvedValue({ id: 1 });
		mocks.repo.insertMessage.mockResolvedValue({
			id: 10,
			conversationId: 1,
			senderId: 6,
			type: "text",
			content: "hello",
			attachmentUrl: null,
			readAt: null,
			createdAt: new Date(),
			deletedAt: null,
		});
	});

	it("publishes message:new to recipient and sender channels", async () => {
		const service = await loadService();
		mocks.publishUser.mockReset();
		mocks.publishUser.mockResolvedValue(undefined);

		await service.send(auth, { recipientId: 5, content: "hello" });

		expect(mocks.publishUser).toHaveBeenCalledTimes(4);
		const types = mocks.publishUser.mock.calls.map(([uid, env]) => [uid, env?.data?.type]);
		expect(types.filter(([, t]) => t === "message:new")).toEqual([
			[5, "message:new"],
			[6, "message:new"],
		]);
		expect(types.filter(([, t]) => t === "conversation:updated")).toHaveLength(2);
	});

	it("rejects the 31st message in a minute with 429", async () => {
		const service = await loadService();
		mocks.redis.incr.mockReset();
		mocks.redis.incr.mockResolvedValueOnce(30).mockResolvedValueOnce(31);

		await expect(service.send(auth, { recipientId: 5, content: "ok" })).resolves.toBeTruthy();
		await expect(service.send(auth, { recipientId: 5, content: "ok" })).rejects.toThrow(
			"sending messages too fast",
		);
	});

	it("rejects empty messages (no content, no attachment)", async () => {
		const service = await loadService();
		await expect(service.send(auth, { recipientId: 5 })).rejects.toThrow(
			"Message content or attachment is required",
		);
	});

	it("rejects messaging yourself", async () => {
		const service = await loadService();
		await expect(service.send(auth, { recipientId: 6, content: "hi" })).rejects.toThrow(
			"You cannot message yourself",
		);
	});

	it("persists the message with trimmed content", async () => {
		const service = await loadService();
		const result = await service.send(auth, { recipientId: 5, content: "  hello  " });
		expect(mocks.repo.insertMessage).toHaveBeenCalledWith(
			expect.objectContaining({ conversationId: 1, content: "hello", type: "text" }),
		);
		expect(result.message!.id).toBe(10);
	});

	it("creates the conversation when missing, then sends", async () => {
		const service = await loadService();
		mocks.repo.findDirectBetween.mockResolvedValue(null);
		mocks.repo.getPrimaryRole.mockResolvedValue("student");
		mocks.repo.createDirect.mockResolvedValue({ id: 9 });

		await service.send(auth, { recipientId: 5, content: "first" });
		expect(mocks.repo.createDirect).toHaveBeenCalled();
		expect(mocks.repo.insertMessage).toHaveBeenCalledWith(
			expect.objectContaining({ conversationId: 9 }),
		);
	});
});

describe("MessagingService.listMessages / markRead", () => {
	beforeEach(() => {
		mocks.repo.isParticipant.mockReset();
		mocks.repo.listMessages.mockReset();
		mocks.repo.markRead.mockReset();
		mocks.repo.getPeerId.mockReset();
		mocks.publishUser.mockReset();
	});

	it("blocks non-participants with 403", async () => {
		const service = await loadService();
		mocks.repo.isParticipant.mockResolvedValue(false);
		await expect(service.listMessages(auth, 1)).rejects.toThrow(
			"You are not a participant of this conversation",
		);
		await expect(service.markRead(auth, 1)).rejects.toThrow(
			"You are not a participant of this conversation",
		);
	});

	it("publishes message:read to me and the peer", async () => {
		const service = await loadService();
		mocks.repo.isParticipant.mockResolvedValue(true);
		mocks.repo.markRead.mockResolvedValue(undefined);
		mocks.repo.getPeerId.mockResolvedValue(5);

		await service.markRead(auth, 1);

		expect(mocks.publishUser).toHaveBeenCalledTimes(2);
		const types = mocks.publishUser.mock.calls.map(([uid, env]) => [uid, env?.data?.type]);
		expect(types).toEqual([
			[6, "message:read"],
			[5, "message:read"],
		]);
	});

	it("returns messages ascending with hasMore metadata", async () => {
		const service = await loadService();
		mocks.repo.isParticipant.mockResolvedValue(true);
		const mk = (id: number) => ({
			id, conversationId: 1, senderId: 6, type: "text", content: `m${id}`,
			attachmentUrl: null, readAt: null, createdAt: new Date(), deletedAt: null,
			senderFirstName: "Testing", senderLastName: "User", senderEmail: "s@hive.test",
			senderAvatarUrl: null,
		});
		// Repo returns newest-first with limit+1 rows (hasMore when 3 rows for limit 2)
		mocks.repo.listMessages.mockResolvedValue([mk(4), mk(3), mk(2)]);

		const result = await service.listMessages(auth, 1, undefined, 2);
		expect(result.data.map((m: any) => m.id)).toEqual([3, 4]); // ascending
		expect(result.meta.hasMore).toBe(true);
		expect(result.meta.nextBefore).toBe(3);
	});
});

describe("MessagingService.remove", () => {
	beforeEach(() => {
		mocks.repo.findMessage.mockReset();
		mocks.repo.softDeleteMessage.mockReset();
	});

	it("only the sender can delete their message", async () => {
		const service = await loadService();
		mocks.repo.findMessage.mockResolvedValue({ id: 1, conversationId: 1, senderId: 5 });
		await expect(service.remove(auth, 1)).rejects.toThrow(
			"You can only delete your own messages",
		);
		expect(mocks.repo.softDeleteMessage).not.toHaveBeenCalled();
	});

	it("deletes own message with soft delete", async () => {
		const service = await loadService();
		mocks.repo.findMessage.mockResolvedValue({ id: 1, conversationId: 1, senderId: 6 });
		mocks.repo.softDeleteMessage.mockResolvedValue({
			id: 1, conversationId: 1, senderId: 6, deletedAt: new Date(),
		});
		mocks.repo.getParticipantIds.mockResolvedValue([6, 5]);

		const result = await service.remove(auth, 1);
		expect(result).toEqual({ messageId: 1, conversationId: 1 });
		expect(mocks.repo.softDeleteMessage).toHaveBeenCalledWith(1);
		expect(mocks.publishUser).toHaveBeenCalledTimes(2);
	});
});
