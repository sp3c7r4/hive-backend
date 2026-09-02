import { access, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Handlebars from "handlebars";
import open from "open";
import { config } from "@/config";
import type { EmailOptions } from "@/interfaces";
import { logger } from "@/utils";
import nodemailer from "nodemailer";

export class EmailService {
	private static instance: EmailService;

	private readonly domain: string = config.mail.domain;

	private readonly transporter: nodemailer.Transporter;

	private log = logger;

	private sender: string = `no-reply@${this.domain}`;

	static getInstance(): EmailService {
		if (!this.instance) {
			this.instance = new EmailService();
		}
		return this.instance;
	}

	private constructor() {
		/* @info - Resend SMTP (smtp.resend.com). Same nodemailer contract the
		 * SES transport had; only the endpoint/creds changed. */
		this.transporter = nodemailer.createTransport({
			host: "smtp.resend.com",
			port: 465,
			secure: true,
			auth: {
				user: "resend",
				pass: config.aws.resend.apiKey,
			},
		});
	}

	private async getTemplate(template: string): Promise<string> {
		/* @info - dist/emails on prod (src isn't shipped), src/emails in dev */
		const distDir = path.join(process.cwd(), "dist", "emails");
		const srcDir = path.join(process.cwd(), "src", "emails");
		const templatesDir = existsSync(distDir) ? distDir : srcDir;
		const pathName = path.join(templatesDir, template, "html.hbs");

		if (!pathName.startsWith(templatesDir + path.sep)) {
			throw new Error(`Invalid template name: ${template}`);
		}

		await access(pathName).catch(() => {
			throw new Error(`Email template ${template} not found.`);
		});
		return await readFile(pathName, "utf-8");
	}

	send = async (options: EmailOptions) => {
		if (!options.template) throw new Error("Email template is required.");

		const templateContent = await this.getTemplate(options.template);
		const template = Handlebars.compile(templateContent);
		const html = template(options.locals || {});

		const params: Record<string, any> = {
			from: options.identifier
				? `${options.identifier}@${this.domain}`
				: this.sender,
			to: options.message.to,
			subject: options.message.subject,
			cc: options.message?.cc,
			bcc: options.message?.bcc,
			replyTo: options.message?.replyTo,
		};

		if (options?.bodyMode === "text") {
			params.text = options.message.text;
		} else {
			params.html = html;
		}

		let tmpPath: string = "";

		try {
			if (config.env === "development") {
				tmpPath = path.join(tmpdir(), `email-preview-${Date.now()}.html`);
				await writeFile(tmpPath, html);
				await open(tmpPath, {});
			} else {
				await this.transporter.sendMail(params);
			}

			this.log.info(`Email sent to ${options.message.to}`);
		} catch (e) {
			this.log.error(
				`Failed to send email to ${options.message.to}: ${e instanceof Error ? e.message : "Unknown error"}`,
			);
		}
	};
}
