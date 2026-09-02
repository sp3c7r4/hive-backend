import { describe, expect, it } from "vitest";
import {
	extractDriveFileId,
	isGoogleDriveLink,
} from "@/helpers/google-drive.helper";

describe("extractDriveFileId", () => {
	it("extracts from /file/d/{id}/view", () => {
		expect(
			extractDriveFileId(
				"https://drive.google.com/file/d/ABC123xyz/view?usp=sharing",
			),
		).toBe("ABC123xyz");
	});

	it("extracts from /open?id={id}", () => {
		expect(extractDriveFileId("https://drive.google.com/open?id=FILE999")).toBe(
			"FILE999",
		);
	});

	it("accepts docs.google.com (Docs/Sheets/Slides)", () => {
		expect(
			extractDriveFileId("https://docs.google.com/document/d/DOC456/edit"),
		).toBe("DOC456");
	});

	it("returns null for non-Google domains", () => {
		expect(extractDriveFileId("https://youtube.com/watch?v=x")).toBeNull();
		expect(extractDriveFileId("https://dropbox.com/s/abc/file.pdf")).toBeNull();
	});

	it("returns null for a Google domain without a file id", () => {
		expect(
			extractDriveFileId("https://drive.google.com/drive/my-drive"),
		).toBeNull();
	});

	it("returns null for garbage", () => {
		expect(extractDriveFileId("not a url")).toBeNull();
		expect(extractDriveFileId("")).toBeNull();
	});
});

describe("isGoogleDriveLink", () => {
	it("accepts valid share links", () => {
		expect(isGoogleDriveLink("https://drive.google.com/file/d/ABC/view")).toBe(
			true,
		);
	});

	it("rejects non-Google and id-less links", () => {
		expect(isGoogleDriveLink("https://vimeo.com/123")).toBe(false);
		expect(isGoogleDriveLink("https://drive.google.com/drive/home")).toBe(
			false,
		);
	});
});
