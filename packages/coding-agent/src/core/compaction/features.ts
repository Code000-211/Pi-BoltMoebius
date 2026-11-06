/**
 * Pi-Lightspeed's additions to compaction, each on. Tests of Pi's own compaction (its requests, its thresholds) turn
 * them off here; nothing else does.
 */
export const compactionFeatures = {
	/** The summary is made in the background before the threshold is reached (AgentSession._compactAhead). */
	ahead: true,
	/** The summary is asked as the continuation of the session's own request (compactOnCachedPrefix). */
	cachedPrefix: true,
	/** The user's compacted messages stay verbatim beside the summary (userMessagesBefore). */
	userMessages: true,
};
