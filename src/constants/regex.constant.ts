export const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const mongoIdRegex = /^[0-9a-fA-F]{24}$/;

export const urlRegex = /^(https?:\/\/)?([\w-]+(\.[\w-]+)+)(\/[^\s]*)?$/i;

export const phoneNumberRegex = /^\+\d{10,15}$/;

/* Link regex */
export const githubLinkRegex = /^(https?:\/\/)?(www\.)?github\.com\/[^\s/]+$/i;
export const behanceLinkRegex =
	/^(https?:\/\/)?(www\.)?behance\.net\/[^\s/]+$/i;
export const xLinkRegex = /^(https?:\/\/)?(www\.)?x\.com\/[^\s/]+$/i;
export const linkedinLinkRegex =
	/^(https?:\/\/)?(www\.)?linkedin\.com\/in\/[^\s/]+$/i;
export const dribbleLinkRegex =
	/^(https?:\/\/)?(www\.)?dribbble\.com\/[^\s/]+$/i;
export const threadsLinkRegex =
	/^(https?:\/\/)?(www\.)?threads\.net\/[^\s/]+$/i;

/** @deprecated */ export const twitterLinkRegex =
	/^(https?:\/\/)?(www\.)?twitter\.com\/[^\s/]+$/i;
