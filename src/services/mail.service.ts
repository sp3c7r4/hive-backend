import { access, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Handlebars from "handlebars";
import open from "open";
import { config } from "@/config";
import type { EmailOptions } from "@/interfaces";
import { logger } from "@/utils";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import nodemailer from "nodemailer";
import { existsSync } from "node:fs";

// const ses =

export class EmailService {
	private static instance: EmailService;

	private readonly domain: string = config.mail.domain;

	private readonly ses: SESv2Client;
	private readonly transporter: nodemailer.Transporter;

	private logger = logger;

	private sender: string = `no-reply@${this.domain}`;

	/**
	 * @info - Gets Singleton instance
	 * @returns {EmailService}
	 */
	static getInstance(): EmailService {
		if (!this.instance) {
			this.instance = new EmailService();
		}
		return this.instance;
	}

	/* @todo - `no-reply@${config.server.serverDomain}` */
	private constructor() {
		this.ses = new SESv2Client({
			region: config.aws.region, // must match the region your identity is verified in
			credentials: {
				accessKeyId: config.aws.ses.user!,
				secretAccessKey: config.aws.ses.password!,
			},
		});
		this.transporter = nodemailer.createTransport({
			//@ts-ignore
			SES: {
				sesClient: this.ses,
				SendEmailCommand,
			},
		});
	}

	private async getTemplate(template: string): Promise<string> {
		const bundledDir = path.join(import.meta.dirname, "emails");
		const sourceDir = path.join(process.cwd(), "src", "emails");
		const templatesDir = existsSync(bundledDir) ? bundledDir : sourceDir;

		const pathName = path.join(templatesDir, template, "html.hbs");
		console.log(pathName);
		console.log(import.meta.url);
		console.log(import.meta.dirname);
		console.log(import.meta.dirname);

		if (!pathName.startsWith(templatesDir + path.sep)) {
			throw new Error(`Invalid template name: ${template}`);
		}

		await access(pathName).catch(() => {
			throw new Error(`Email template ${template} not found.`);
		});
		return await readFile(pathName, "utf-8");
	}

	/**
	 * Compiles and sends an email using the specified template and options.
	 * In development, renders the email as an HTML preview in the browser.
	 *
	 * @param options - {@link EmailOptions} configuration for the email
	 * @param options.template - Template name matching a directory under `src/emails/`
	 * @param options.message - Recipient, subject, and optional cc/bcc/replyTo fields
	 * @param options.locals - Variables passed to the Handlebars template
	 * @param options.identifier - Optional sender prefix (e.g. `notification@domain`)
	 * @param options.bodyMode - Send as `"html"` (default) or `"text"`
	 * @throws {Error} If no template is provided or the template file is not found
	 */
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

			this.logger.info(`Email sent to ${options.message.to}`);
		} catch (e) {
			this.logger.error(
				`Failed to send email to ${options.message.to}: ${e instanceof Error ? e.message : "Unknown error"}`,
			);
		} finally {
			/** @info - Since we're saving the files in the tempdir we don't need to delete them */
			// setTimeout(() => {
			// 	unlink(tmpPath, (err) => {
			// 		if (err)
			// 			this.logger.error(
			// 				`Failed to delete temp email preview file: ${err instanceof Error ? err.message : "Unknown error"}`,
			// 			);
			// 		else this.logger.info(`Temp email preview file deleted: ${tmpPath}`);
			// 	});
			// }, 5000);
		}
	};
}
