import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import Handlebars from "handlebars";
import nodemailer from "nodemailer";
import open from "open";
import { config } from "@/config";
import type { EmailOptions } from "@/interfaces";
import { logger } from "@/utils";

Handlebars.registerHelper("gt", (a, b) => a > b);

export type MailProvider = "ses" | "resend";

/* @info - Exported so the test can pin them: the region must be the one the identity is
 * verified in, and the from-domain must belong to the provider doing the sending (Resend
 * answers 550 for a domain it has not verified, SES for an identity it does not hold). */
export const sesClientOptions = () => ({
	region: config.aws.region,
	credentials: {
		accessKeyId: config.aws.accessKeyId,
		secretAccessKey: config.aws.secretAccessKey,
	},
});

export const mailFromDomain = (provider: MailProvider): string =>
	provider === "ses" ? config.mail.domain : config.aws.resend.domain;

export const mailSender = (provider: MailProvider) => ({
	name: "Hive",
	address: `no-reply@${mailFromDomain(provider)}`,
});

export const buildTransport = (
	provider: MailProvider,
): nodemailer.Transporter =>
	provider === "ses"
		? nodemailer.createTransport({
				/* @info - nodemailer's SES transport, handed the v2 command the rest of this
				 *         project's AWS code uses. Credentials come from the environment the
				 *         way S3's client takes them. */
				// @ts-expect-error nodemailer's SES transport type omits the sesv2 shape
				SES: {
					sesClient: new SESv2Client(sesClientOptions()),
					SendEmailCommand,
				},
			})
		: nodemailer.createTransport({
				host: "smtp.resend.com",
				port: 465,
				secure: true,
				auth: {
					user: "resend",
					pass: config.aws.resend.apiKey,
				},
			});

export class EmailService {
	private static instance: EmailService;

	/* @info - The from-domain follows the provider, not the other way round: SES holds an
	 * identity for MAIL_DOMAIN, Resend holds a verified domain of its own. */
	private readonly provider: MailProvider = config.mail.provider;

	private readonly domain: string = mailFromDomain(this.provider);

	private readonly transporter: nodemailer.Transporter;

	private log = logger;

	private sender: { name: string; address: string } = mailSender(this.provider);

	static getInstance(): EmailService {
		if (!this.instance) {
			this.instance = new EmailService();
		}
		return this.instance;
	}

	private constructor() {
		/* @info - Resend SMTP (smtp.resend.com) or SES, chosen by MAIL_PROVIDER. Same
		 * nodemailer contract either way; only the endpoint and credentials differ, so
		 * switching back is one environment value and a restart. */
		this.transporter = buildTransport(config.mail.provider);
	}

	private async getTemplate(template: string): Promise<string> {
		/* @info - dist/emails on prod (src isn't shipped), src/emails in dev.
		 *         Resolve per-file, not per-directory: a stale dist/ in dev
		 *         otherwise hides templates added since the last build. */
		const distDir = path.join(process.cwd(), "dist", "emails");
		const srcDir = path.join(process.cwd(), "src", "emails");
		const pathName = [
			path.join(distDir, template, "html.hbs"),
			path.join(srcDir, template, "html.hbs"),
		].find((candidate) => existsSync(candidate));

		if (!pathName) {
			throw new Error(`Email template ${template} not found.`);
		}
		if (
			!pathName.startsWith(distDir + path.sep) &&
			!pathName.startsWith(srcDir + path.sep)
		) {
			throw new Error(`Invalid template name: ${template}`);
		}

		return await readFile(pathName, "utf-8");
	}

	send = async (options: EmailOptions) => {
		if (!options.template) throw new Error("Email template is required.");

		const templateContent = await this.getTemplate(options.template);
		const template = Handlebars.compile(templateContent);
		const html = template(options.locals || {});

		const params: Record<string, any> = {
			from: options.identifier
				? { name: "Hive", address: `${options.identifier}@${this.domain}` }
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
