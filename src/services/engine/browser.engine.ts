import { config } from "@/config";
import path from "node:path";
import { existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import puppeteer, { type Browser, type PDFOptions } from "puppeteer";
import Handlebars from "handlebars";
import { serviceLogger } from "@/utils/logger";
import type { Templates } from "@/enums";

export class BrowserEngine {
	private static instance: BrowserEngine;
	private browser: Browser | null = null;

	/** @info - Utilities */
	private log = serviceLogger("Browser Engine");

	static getInstance(): BrowserEngine {
		if (!this.instance) this.instance = new BrowserEngine();
		return this.instance;
	}

	private constructor() {
		this.setupListeners();
	}

	async start() {
		// Guard against a second launch if start() is ever called twice
		// (e.g. from a health-check restart routine later).
		if (this.browser) return;

		this.browser = await puppeteer.launch({
			headless: true,
			args: ["--no-sandbox", "--disable-setuid-sandbox"],
		});
		this.log.info("Browser engine started successfully ⚡");
	}

	getBrowser(): Browser {
		if (!this.browser) {
			this.log.error("Browser engine accessed before start() was called");
			// This is a startup failure, not a clean exit — process.exit(0)
			// tells your process manager "shut down on purpose", which would
			// suppress restarts/alerts for what's actually a bug.
			process.exit(1);
		}
		return this.browser;
	}

	private closeBrowser = async () => {
		// The original version called this.browser.close() with no guard,
		// even though browser is typed Browser | null — TS would flag that
		// under strict null checks, and it'd throw at runtime if somehow
		// called before start().
		if (!this.browser) return;
		await this.browser.close();
		this.browser = null;
	};

	private setupListeners() {
		const shutdown = async (signal: string) => {
			try {
				await this.closeBrowser();
				this.log.info(`Browser closed gracefully (${signal})`);
				process.exit(0);
			} catch (err) {
				this.log.error("Error closing browser:", { error: err });
				process.exit(1);
			}
		};
		process.on("SIGINT", () => shutdown("SIGINT"));
		process.on("SIGTERM", () => shutdown("SIGTERM"));
	}
}

/**
 * Shared PDF-generation mechanics for anything that renders a Handlebars
 * template to a PDF — receipts, invoices, shipping labels, whatever comes
 * next. Subclasses only need to say WHERE their templates live and HOW to
 * turn their own options into HTML; this class handles opening a page on
 * the ONE shared browser, printing, and cleaning the page back up.
 *
 * Deliberately has NO static instance/getInstance of its own. This class
 * is abstract, so `new FileGenerator()` can never happen directly — and
 * more importantly, a static field declared HERE would be shared across
 * every subclass, because static members in JS/TS aren't re-scoped per
 * subclass unless the subclass redeclares them. If ReceiptGenerator and
 * InvoiceGenerator both just inherited a getInstance() defined here,
 * `InvoiceGenerator.getInstance()` would silently hand back whichever
 * instance was created FIRST — even if that was actually a
 * ReceiptGenerator — because they'd all be reading and writing the exact
 * same inherited static property. Each concrete subclass needs its own
 * static instance/getInstance(), the same pattern AgentService,
 * ProductRepository, etc. already use elsewhere in this codebase.
 */
export abstract class FileGenerator<T> {
	protected readonly fallbackLogo: string = config.server.logo.dark;
	protected readonly browserEngine: BrowserEngine;
	protected readonly log = serviceLogger(this.constructor.name);

	protected constructor() {
		this.browserEngine = BrowserEngine.getInstance();
	}

	/**
	 * Which folder this subclass's templates live in — e.g. "emails",
	 * "receipts", "invoices". Left abstract rather than hardcoded to
	 * "emails" (as the original getTemplate was) so every document type
	 * gets its own template directory instead of being forced into one.
	 */
	protected abstract readonly templatesFolder: string;

	/**
	 * Turn this generator's options into a final HTML string — typically by
	 * calling this.getTemplate(name) for the raw .hbs source, then
	 * this.compile(source, data) to render it. Left to each subclass since
	 * every document type has its own data shape, its own totals/formatting,
	 * its own logo-fallback logic, etc.
	 */
	protected abstract buildHtml(options: T): Promise<string> | string;

	/**
	 * Loads the raw .hbs source for `template` from this subclass's
	 * templatesFolder, expecting the layout <templatesFolder>/<template>/html.hbs
	 * — matching the bundled-vs-source resolution the original getTemplate
	 * already had, just parameterized instead of hardcoded to "emails".
	 */
	protected async getTemplate(template: Templates): Promise<string> {
		const bundledDir = path.join(import.meta.dirname, this.templatesFolder);
		const sourceDir = path.join(process.cwd(), "src", this.templatesFolder);
		const templatesDir = existsSync(bundledDir) ? bundledDir : sourceDir;
		const pathName = path.join(templatesDir, template, "html.hbs");

		if (!pathName.startsWith(templatesDir + path.sep)) {
			throw new Error(`Invalid template name: ${template}`);
		}

		await access(pathName).catch(() => {
			throw new Error(
				`Template "${template}" not found in ${this.templatesFolder}.`,
			);
		});

		return await readFile(pathName, "utf-8");
	}

	protected compile<D extends object>(source: string, data: D): string {
		return Handlebars.compile(source)(data);
	}

	async generateFile(
		options: T,
		pdfOptions?: Partial<PDFOptions>,
	): Promise<Buffer> {
		const html = await this.buildHtml(options);
		const browser = this.browserEngine.getBrowser();

		const page = await browser.newPage();
		try {
			await page.setContent(html, { waitUntil: "load" });

			const pdf = await page.pdf({
				format: "A4",
				printBackground: true,
				margin: { top: "0", bottom: "0", left: "0", right: "0" },
				...pdfOptions,
			});

			return Buffer.from(pdf);
		} finally {
			await page.close();
		}
	}
}
