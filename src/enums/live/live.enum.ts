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

/**
 * @info - Where a session's recording is (phase 5a, spec section 4). `recording` is
 * the egress running, `processing` is "we asked it to stop, the file is still being
 * written" - shown to the host as itself rather than as a spinner. `failed` is only
 * ever visible to the host (D-P5-10), and `deleted` is the host having destroyed one:
 * distinct from a null status, which means nothing was ever recorded. `expired` is
 * deliberately not a value here - it is derived from the bucket's 90-day lifecycle.
 */
export enum RecordingStatus {
	RECORDING = "recording",
	PROCESSING = "processing",
	READY = "ready",
	FAILED = "failed",
	DELETED = "deleted",
}
