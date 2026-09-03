/**
 * @info - Hand-written AI guardrails (no package): PII + injection
 * heuristics shared by the course tutor and the course builder. Pure
 * functions, no module imports (helpers rule).
 */

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE_RE = /(\+?\d[\d\s-]{9,14}\d)/;
const INJECTION_PHRASES = [
	"ignore previous instructions",
	"ignore your instructions",
	"ignore all previous",
	"ignore your system prompt",
	"you are now",
	"act as an unrestricted",
	"forget everything",
	"jailbreak",
	"reveal your system prompt",
	"system prompt",
	"developer message",
];

/** @info - Screen user-supplied input before it reaches the model.
 * Returns null when clean, or a short reason ("pii" | "injection"). */
export function runInputGuardrails(input: string): "pii" | "injection" | null {
	if (EMAIL_RE.test(input) || PHONE_RE.test(input)) return "pii";
	const lower = input.toLowerCase();
	if (INJECTION_PHRASES.some((p) => lower.includes(p))) return "injection";
	return null;
}

/** @info - Screen model-produced prose after generation (audit use: a
 * flagged draft is logged as blocked; render-time sanitize is the
 * enforcement boundary). Same heuristics as the input check. */
export function screenAssistantOutput(
	fields: Array<string | null | undefined>,
): "pii" | "injection" | null {
	for (const field of fields) {
		if (!field) continue;
		const hit = runInputGuardrails(field);
		if (hit) return hit;
	}
	return null;
}
