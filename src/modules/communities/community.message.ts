export const CommunityMessages = {
	NOT_FOUND: "Community not found",
	DELETED: "Community deleted",
	CREATED: "Community created",
	/* @info - The number matches BULK_INVITE_DAILY_LIMIT in community-member.service.ts;
	 *         they are read together or the message lies. */
	INVITE_CAP_REACHED:
		"This community has reached its daily limit of 200 invitations. Try again tomorrow",
};
