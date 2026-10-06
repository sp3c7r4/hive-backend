import { SESv2Client } from "@aws-sdk/client-sesv2";
import { describe, expect, it } from "vitest";
import { config } from "@/config";
import {
	buildTransport,
	mailFromDomain,
	mailSender,
	sesClientOptions,
} from "@/services/mail.service";

/* @info - The mail provider is configuration, so these tests pin the two things that go
 * wrong silently: sending from a domain the chosen provider has not verified, and pointing
 * SES at a region where the identity does not exist. Neither shows up until a real recipient
 * misses an email. */
describe("mail provider", () => {
	it("defaults to resend when MAIL_PROVIDER is absent, so a deploy cannot change behaviour", () => {
		/* The dev environment does not set it; production sets it explicitly when flipped. */
		expect(config.mail.provider).toBe("resend");
		expect(mailFromDomain("resend")).toBe(config.aws.resend.domain);
	});

	it("builds the SES transport for ses and the SMTP transport otherwise", () => {
		/* @info - nodemailer exposes no type name on a transport, so this reads the options it
		 * was built with: an SES key exists only on the SES transport. */
		const sesOptions = (buildTransport("ses") as any).options;
		const smtpOptions = (buildTransport("resend") as any).options;

		expect(sesOptions.SES).toBeDefined();
		expect(smtpOptions.SES).toBeUndefined();
		expect(smtpOptions.host).toBe("smtp.resend.com");
	}, 20000);

	it("hands the SES transport a real client in the app's region, where the identity is verified", async () => {
		expect(sesClientOptions().region).toBe(config.aws.region);

		/* The client inside the transport, not just the options that fed it: this is what
		 * proves the region reaches SES. */
		const client = (buildTransport("ses") as any).options.SES.sesClient;
		expect(client).toBeInstanceOf(SESv2Client);
		await expect(client.config.region()).resolves.toBe(config.aws.region);
	}, 20000);

	it("sends from the domain each provider holds, under the same display name", () => {
		expect(mailFromDomain("ses")).toBe(config.mail.domain);
		expect(mailFromDomain("ses")).not.toBe(config.aws.resend.domain);
		expect(mailSender("ses")).toEqual({
			name: "Hive",
			address: `no-reply@${config.mail.domain}`,
		});
	});
});
