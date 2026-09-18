/**
 * @info - Turns a published lesson into plain text suitable for embedding.
 *
 * Groundable types: TEXT (rich description), QUIZ (questions + instructor
 * explanations), ASSIGNMENT (description + rubric), PDF (parsed via unpdf),
 * PPTX (slide XML read straight out of the OOXML zip), GOOGLE_DRIVE
 * (conditional: public Google Docs text export only).
 * Returns null for lessons with nothing extractable.
 */
import { extractText, getDocumentProxy } from "unpdf";
import AdmZip from "adm-zip";
import type { Lesson } from "@/modules/courses/course.model";
import type { QuizQuestion } from "@/modules/assessments/assessment.model";
import { LessonType } from "@/enums";
import { extractDriveFileId } from "@/helpers/google-drive.helper";

/** @info - Very small HTML stripper for editor content (tiptap HTML) */
export function stripHtml(html?: string | null): string {
	if (!html) return "";
	return html
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}

export async function fetchBuffer(url: string): Promise<Uint8Array | null> {
	return fetch(url, {
		headers: { "User-Agent": "Mozilla/5.0 (compatible; HiveTutor/1.0)" },
		signal: AbortSignal.timeout(20_000),
	})
		.then(async (res) => {
			if (!res.ok) return null;
			const contentType = res.headers.get("content-type") ?? "";
			/* @info - HTML means an error/login page, not the document */
			if (contentType.includes("text/html")) return null;
			const buf = new Uint8Array(await res.arrayBuffer());
			return buf.length === 0 ? null : buf;
		})
		.catch(() => null);
}

export async function fetchPdfText(url: string): Promise<string | null> {
	const buf = await fetchBuffer(url);
	if (buf === null) return null;
	try {
		const pdf = await getDocumentProxy(buf);
		const { text } = await extractText(pdf, { mergePages: true });
		return text.trim() || null;
	} catch {
		return null;
	}
}

/** @info - "slide12.xml" -> 12. Lexical order would put slide10 before slide2. */
function slideNumber(entryName: string): number {
	return Number(entryName.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
}

/** @info - XML character references. `&amp;` is decoded LAST so an escaped
 * entity like &amp;lt; does not become a second round of markup. */
function decodeXmlEntities(value: string): string {
	return value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
			String.fromCodePoint(Number.parseInt(hex, 16)),
		)
		.replace(/&#(\d+);/g, (_, dec: string) =>
			String.fromCodePoint(Number(dec)),
		)
		.replace(/&amp;/g, "&");
}

/** @info - One paragraph's worth of runs. Every visible run of slide text sits
 * in an <a:t> element; splitting on </a:p> first keeps the author's paragraph
 * breaks instead of flattening the slide into one line. */
function extractSlideText(slideXml: string): string {
	return slideXml
		.split(/<\/a:p>/)
		.map((paragraph) =>
			[...paragraph.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
				.map((match) => decodeXmlEntities(match[1] ?? ""))
				.join("")
				.trim(),
		)
		.filter(Boolean)
		.join("\n");
}

export async function extractPptxText(url: string): Promise<string | null> {
	const buf = await fetchBuffer(url);
	if (buf === null) return null;
	return extractPptxFromBuffer(buf);
}

/**
 * @info - Slides have no text layer to read, so the OOXML is parsed directly: a
 * .pptx is a ZIP whose slide text lives in <a:t> elements of
 * ppt/slides/slideN.xml. Pure bytes-in/text-out so it is testable without a
 * network or a database; the fetch wrapper above is the only I/O.
 * @returns Slide text in numeric slide order, or null if nothing is readable.
 */
export function extractPptxFromBuffer(buf: Uint8Array): string | null {
	try {
		const zip = new AdmZip(Buffer.from(buf));
		const text = zip
			.getEntries()
			.filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
			.sort((a, b) => slideNumber(a.entryName) - slideNumber(b.entryName))
			.map((entry) => extractSlideText(entry.getData().toString("utf-8")))
			.filter(Boolean)
			.join("\n\n")
			.trim();
		return text || null;
	} catch {
		/* @info - Encrypted, corrupt, or not actually a zip. The lesson simply is
		 * not indexed; the student's viewer reports the same file to them. */
		return null;
	}
}

async function fetchPlainText(url: string): Promise<string | null> {
	const buf = await fetchBuffer(url);
	if (buf === null) return null;
	try {
		const text = new TextDecoder().decode(buf).trim();
		return text && !text.startsWith("<") ? text : null;
	} catch {
		return null;
	}
}

function formatQuizQuestions(questions: QuizQuestion[]): string {
	return questions
		.map((q, i) => {
			const parts = [`Question ${i + 1}: ${q.text}`];
			if (q.explanation) parts.push(`Explanation: ${q.explanation}`);
			return parts.join("\n");
		})
		.join("\n\n");
}

function extractAssignment(lesson: Lesson): string {
	const parts = [stripHtml(lesson.description)];
	const settings = (lesson.settings ?? {}) as Record<string, unknown>;
	const rubric = Array.isArray(settings.rubric)
		? (settings.rubric as Array<{ criteria?: string; maxPoints?: string }>)
				.map((r) => `- ${r.criteria ?? ""} (${r.maxPoints ?? ""} pts)`)
				.join("\n")
		: "";
	if (rubric) parts.push(`Rubric:\n${rubric}`);
	return parts.filter(Boolean).join("\n\n");
}

/**
 * @info - Best-effort text for a published lesson. Anything that can't be
 * fetched/parsed returns null and the lesson is simply not indexed.
 */
export async function extractLessonText(
	lesson: Lesson,
	questions: QuizQuestion[],
): Promise<string | null> {
	switch (lesson.type) {
		case LessonType.TEXT:
			return stripHtml(lesson.description) || null;
		case LessonType.QUIZ:
			return formatQuizQuestions(questions) || null;
		case LessonType.ASSIGNMENT: {
			const text = extractAssignment(lesson);
			return text || null;
		}
		case LessonType.PDF: {
			if (!lesson.pdfUrl) return null;
			return fetchPdfText(lesson.pdfUrl);
		}
		case LessonType.PPTX: {
			if (!lesson.pptxUrl) return null;
			return extractPptxText(lesson.pptxUrl);
		}
		case LessonType.GOOGLE_DRIVE: {
			if (!lesson.driveUrl) return null;
			/* @info - Conditional: Google Docs export as plain text; only works
			 * for docs with link sharing. Files/videos return null. */
			if (!lesson.driveUrl.includes("/document/d/")) return null;
			const id = extractDriveFileId(lesson.driveUrl);
			if (!id) return null;
			return fetchPlainText(
				`https://docs.google.com/document/d/${id}/export?format=txt`,
			);
		}
		default:
			return null; // VIDEO, LIVE: no transcript yet
	}
}

/** @info - Chunk by paragraph groups; oversized paragraphs are windowed */
export function chunkText(
	content: string,
	maxLength = 1200,
	overlap = 120,
): string[] {
	const clean = content.replace(/\s+/g, " ").trim();
	if (!clean) return [];
	if (clean.length <= maxLength) return [clean];

	const paragraphs = clean.split(/(?<=\.)\s+(?=[A-Z])/);
	const chunks: string[] = [];
	let buffer = "";

	const push = (text: string) => {
		const t = text.trim();
		if (t) chunks.push(t);
	};

	for (const para of paragraphs) {
		if (para.length > maxLength) {
			push(buffer);
			buffer = "";
			let start = 0;
			while (start < para.length) {
				push(para.slice(start, start + maxLength));
				start += maxLength - overlap;
			}
			continue;
		}
		if (buffer.length + para.length + 1 > maxLength) {
			push(buffer);
			buffer = para;
		} else {
			buffer = buffer ? `${buffer} ${para}` : para;
		}
	}
	push(buffer);
	return chunks;
}
