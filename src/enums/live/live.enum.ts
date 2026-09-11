/**
 * @info - A live session is either a Hive room (native) or somebody else's
 * meeting link (external). Native sessions get a LiveKit room named after the
 * session id; external ones just carry a URL the client opens in a new tab.
 */
export enum LiveSessionKind {
	NATIVE = "native",
	EXTERNAL = "external",
}

/**
 * @info - Lifecycle of a live session. `cancelled` is reserved for the standalone
 * events work (phase 2); the column exists now so the type does not churn later.
 * `ended` and `cancelled` are host-only joinable (reconnect for cleanup).
 */
export enum LiveSessionStatus {
	SCHEDULED = "scheduled",
	LIVE = "live",
	ENDED = "ended",
	CANCELLED = "cancelled",
}
