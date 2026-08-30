import { describe, it, expect, vi } from "vitest";
import { WebsocketEngine } from "@/services/engine/websocket.engine";

/** @info - Fake socket with the minimal contract the engine needs. */
const fakeSocket = (overrides: Record<string, unknown> = {}) => ({
	sent: [] as string[],
	readyState: 1,
	closed: false,
	send(data: string) {
		this.sent.push(data);
	},
	close() {
		this.closed = true;
		this.readyState = 3;
	},
	...overrides,
});

describe("WebsocketEngine", () => {
	it("adds, sends and removes sockets per user", () => {
		// Fresh instance (singleton reset is awkward; construct via the map check)
		const engine = WebsocketEngine.getInstance();
		engine.remove(999, fakeSocket()); // no-op safety
		expect(engine.onlineCount(999)).toBe(0);

		const a = fakeSocket();
		const b = fakeSocket();
		engine.add(42, a as any);
		engine.add(42, b as any);
		expect(engine.onlineCount(42)).toBe(2);

		engine.send(42, { hello: "world" });
		expect(a.sent).toEqual([JSON.stringify({ hello: "world" })]);
		expect(b.sent).toEqual([JSON.stringify({ hello: "world" })]);

		engine.remove(42, a as any);
		expect(engine.onlineCount(42)).toBe(1);
		engine.remove(42, b as any);
		expect(engine.onlineCount(42)).toBe(0);
	});

	it("does not send to closed sockets", () => {
		const engine = WebsocketEngine.getInstance();
		const dead = fakeSocket({ readyState: 3 });
		const live = fakeSocket();
		engine.add(7, dead as any);
		engine.add(7, live as any);
		engine.send(7, "ping");
		expect(dead.sent).toEqual([]);
		expect(live.sent).toEqual(["ping"]);
		engine.remove(7, dead as any);
		engine.remove(7, live as any);
	});

	it("returns false when a user has no local sockets", () => {
		const engine = WebsocketEngine.getInstance();
		expect(engine.send(12345, "x")).toBe(false);
	});
});
