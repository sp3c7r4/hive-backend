interface Attachment {
	filename?: string;
	content?: string | Buffer;
	path?: string;
	contentType?: string;
	cid?: string;
}

interface MailOptions {
	from?: string;
	to: string | string[];
	cc?: string | string[];
	bcc?: string | string[];
	replyTo?: string;
	subject: string;
	text?: string;
	html: string;
	attachments?: Attachment[];
}

export interface EmailOptions<T = any> {
	/**
	 * The template name
	 */
	template: string;
	/**
	 * Nodemailer Message <Nodemailer.com/message/>
	 *
	 * Overrides what is given for constructor
	 */
	message: MailOptions;
	/**
	 * The Template Variables
	 */
	locals?: T | undefined;
	/**
	 * The identifier for the email, used for tracking and logging purposes
	 * E.g. notification, review, password-reset, etc.
	 */
	identifier?: "notification" | "review" | "password-reset" | string;
	/**
	 * Body mode "html" | "text"
	 */
	bodyMode?: "html" | "text";
}
