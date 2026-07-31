export const PlanMessages = {
	NOT_FOUND: "Plan not found.",
	CREDITS_EXHAUSTED: "Your credits are exhausted. Your bots have been paused.",
	TRIAL_EXPIRED: (name: string) =>
		`Your free trial for "${name}" has ended. Upgrade to a paid plan to resume service.`,
	UPGRADE_PROMPT: "Upgrade your plan to unlock more agents, channels, and messages.",
};
