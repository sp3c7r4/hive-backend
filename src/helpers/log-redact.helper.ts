/**
 * @info - Log redaction. Request and response bodies are logged (see the zod
 * engine's "Serialized result" line), and those bodies carry credentials: every
 * login attempt was written to the box's log with its password in plaintext, and
 * token-bearing responses with their JWTs. Redact by key, at any depth, before
 * anything reaches a log line.
 */

/** @info - Key names whose values must never be logged (matched lower-cased). */
const SENSITIVE_KEYS = new Set([
	"password",
	"passwordhash",
	"newpassword",
	"oldpassword",
	"currentpassword",
	"confirmpassword",
	"token",
	"accesstoken",
	"refreshtoken",
	"idtoken",
	"authorization",
	"cookie",
	"set-cookie",
	"otp",
	"otpcode",
	"verificationcode",
	"twofactorcode",
	"secret",
	"apisecret",
	"clientsecret",
	"apikey",
	"privatekey",
	"cvv",
	"cardnumber",
	"pin",
	"accountnumber",
]);

export const REDACTED = "<redacted>";

/** @info - Recursion beyond this depth is replaced outright rather than trusted. */
const MAX_DEPTH = 8;

/**
 * @info - Returns a copy safe to log: sensitive keys masked at any depth. Never
 * mutate the input; the caller may still need the real values.
 */
export const redactLog = <T>(value: T, depth = 0): T => {
	if (value === null || value === undefined) return value;
	if (depth > MAX_DEPTH) return "<truncated>" as unknown as T;
	if (Array.isArray(value)) {
		return value.map((entry) => redactLog(entry, depth + 1)) as unknown as T;
	}
	if (typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			out[key] = SENSITIVE_KEYS.has(key.toLowerCase())
				? REDACTED
				: redactLog(entry, depth + 1);
		}
		return out as T;
	}
	return value;
};
