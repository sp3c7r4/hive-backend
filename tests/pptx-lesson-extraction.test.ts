import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { extractPptxFromBuffer } from "@/helpers/ai/lesson-content.helper";

/**
 * @info - Pure parse tests for the pptx lesson type. These build a
 * .pptx-shaped zip in memory and never touch the network or the database, so
 * they pin the extraction contract (§10.6-10.8 of the spec) on their own.
 */

/** @info - Only the parts the extractor reads, plus decoys it must ignore. */
function deck(entries: Record<string, string>): Buffer {
	const zip = new AdmZip();
	for (const [name, xml] of Object.entries(entries)) {
		zip.addFile(name, Buffer.from(xml, "utf-8"));
	}
	return zip.toBuffer();
}

function slideXml(...paragraphs: string[]): string {
	const body = paragraphs
		.map((p) => `<a:p><a:r><a:t>${p}</a:t></a:r></a:p>`)
		.join("");
	return `<?xml version="1.0" encoding="UTF-8"?><p:sld><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;
}

describe("extractPptxFromBuffer", () => {
	it("orders slides numerically, not lexically", () => {
		const buf = deck({
			"ppt/slides/slide10.xml": slideXml("tenth"),
			"ppt/slides/slide2.xml": slideXml("second"),
		});
		/* Lexical order would put slide10 first. */
		expect(extractPptxFromBuffer(buf)).toBe("second\n\ntenth");
	});

	it("keeps paragraph breaks without padding runs with spaces", () => {
		const buf = deck({
			"ppt/slides/slide1.xml":
				"<p:sld><a:p><a:r><a:t>Hello </a:t></a:r><a:r><a:t>world</a:t></a:r></a:p>" +
				"<a:p><a:r><a:t>Second line</a:t></a:r></a:p></p:sld>",
		});
		expect(extractPptxFromBuffer(buf)).toBe("Hello world\nSecond line");
	});

	it("decodes entities exactly once", () => {
		const buf = deck({
			"ppt/slides/slide1.xml": slideXml("Tom &amp; Jerry &lt;3"),
		});
		expect(extractPptxFromBuffer(buf)).toBe("Tom & Jerry <3");
	});

	it("does not double-decode an escaped entity", () => {
		const buf = deck({
			"ppt/slides/slide1.xml": slideXml("&amp;lt;"),
		});
		/* "&amp;lt;" is the literal text "&lt;" — it must not become "<". */
		expect(extractPptxFromBuffer(buf)).toBe("&lt;");
	});

	it("ignores notes, layouts and other parts", () => {
		const buf = deck({
			"ppt/slides/slide1.xml": slideXml("Visible"),
			"ppt/notesSlides/notesSlide1.xml": slideXml("Speaker note"),
			"ppt/slideLayouts/slideLayout1.xml": slideXml("Layout"),
		});
		expect(extractPptxFromBuffer(buf)).toBe("Visible");
	});

	it("returns null for a zip that is not a deck", () => {
		const zip = new AdmZip();
		zip.addFile("readme.txt", Buffer.from("hello"));
		expect(extractPptxFromBuffer(zip.toBuffer())).toBeNull();
	});

	it("returns null for a corrupt buffer instead of throwing", () => {
		expect(extractPptxFromBuffer(Buffer.from("not a zip at all"))).toBeNull();
	});

	it("returns null for a deck with no readable text", () => {
		const buf = deck({ "ppt/slides/slide1.xml": slideXml() });
		expect(extractPptxFromBuffer(buf)).toBeNull();
	});
});
