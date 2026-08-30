import { describe, expect, it } from "vitest";
import { toCommunityDto } from "@/modules/communities/community.service";

describe("toCommunityDto", () => {
	it("maps snake_case timestamps to camelCase createdAt/updatedAt", () => {
		const row = {
			id: 1,
			ownerId: 1,
			name: "Hive Devs",
			slug: "hive-devs",
			memberCount: 1,
			created_at: new Date("2025-08-11T10:00:00.000Z"),
			updated_at: new Date("2025-08-11T10:00:00.000Z"),
			deleted_at: null,
		};

		const dto = toCommunityDto(row as any);

		expect(dto.createdAt).toEqual(row.created_at);
		expect(dto.updatedAt).toEqual(row.updated_at);
		expect(dto).not.toHaveProperty("created_at");
		expect(dto).not.toHaveProperty("updated_at");
		expect(dto.name).toBe("Hive Devs");
		expect(dto.memberCount).toBe(1);
	});
});
