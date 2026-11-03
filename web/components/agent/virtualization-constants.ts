/**
 * Threshold (in messages) above which the conversation switches to virtualized
 * rendering. Counted in raw messages rather than turns because agent
 * conversations are message-dense (a single user turn can fan out into dozens
 * of tool/assistant messages inside the agent loop).
 *
 * Lives in a neutral constants module (PR #142 review round 6, Sourcery) so
 * logic-level consumers (useConversationLogic) and view-level consumers
 * (ConversationView) do not have to import it from the ConversationMessages
 * renderer module.
 */
export const VIRTUALIZATION_THRESHOLD = 100
