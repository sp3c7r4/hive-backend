export enum CommunityVisibility {
	PUBLIC = "public",
	PRIVATE = "private",
	INVITE_ONLY = "invite_only",
}

export enum CommunityMemberRole {
	OWNER = "owner",
	ADMIN = "admin",
	MEMBER = "member",
	GUEST = "guest",
}

export enum CommunityMemberStatus {
	ACTIVE = "active",
	BLOCKED = "blocked",
	PENDING = "pending",
}

export enum CommunityInviteStatus {
	PENDING = "pending",
	ACCEPTED = "accepted",
	EXPIRED = "expired",
}
