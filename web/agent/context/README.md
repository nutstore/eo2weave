# Append-only runtime context

Dynamic environment state is published as durable `context_update` messages. System instructions and native tool schemas do not contain skill catalogs, command manuals, project roots, or other mutable environment data.

## Contract

- A source has a stable, conversation-local ID and returns a map from stable entry IDs to model-visible text. A scalar uses one key, such as `value`.
- Collection runs at model-call admission. Unpublished intermediate changes are coalesced naturally: if the model knows 12 skills, a 12 → 100 → 12 change between requests emits nothing.
- An unavailable/throwing source preserves its previous state. An empty map authoritatively withdraws every entry. When disabling a source, keep a collector returning an empty map until the withdrawal is published; omission alone is not deletion.
- Canonical key order makes collection order irrelevant. Providers must normalize unordered fields before rendering values. Only model-visible information should enter entries; avoid timestamps, local cache IDs, and secrets.
- The first publication is a snapshot. Later publications contain only `added`, `updated` (complete replacement entries), and `removed`. Published 12 → 100 → 12 emits a snapshot, 88 additions, then 88 removals.
- The journal includes revision and canonical state identities. Replay rejects missing or inconsistent patch baselines rather than guessing. Exact rendered message content is persisted, never rebuilt using a newer renderer.

## Admission and persistence

`collectContextSources` isolates provider failures. `reconcileContext` is pure: it returns a candidate message without advancing any state. The loop awaits `onContextCommit` before adding that message to either pi-agent's history or the application's history and dispatching the request. The conversation store uses its serialized SQLite transaction path as the durability barrier. In-memory consumers can omit the callback when they do not offer durable sessions.

The message row contains both rendered content and structural provenance in one transaction. No separately persisted singleton baseline can get ahead of the log. Retrying or resuming reconstructs the latest committed state from the same records. Runtime context records are not human turns and are excluded from chat grouping, title generation, and user-turn navigation.

## Consumer boundaries

The persisted `Message` is an application record, not a provider request or a chat bubble. `getMessageRecordType` derives its identity from persisted metadata, including legacy rows. The API `role` describes transport compatibility only: runtime updates, summaries, delegation notes, and read-image handoffs may all use `user` without being human input.

- `isHumanUserMessage` identifies actual user input for titles, suggestions, and activity counts.
- `isConversationUserMessage` identifies execution boundaries, including agent handoffs. Regeneration and delegation retain their existing boundaries.
- `selectConversationTranscript` supplies human input and assistant output to title/suggestion generation, excluding tool payloads and internal records.
- `selectConversationExportMessages` supplies readable single/batch exports, excluding runtime journal entries even when system messages are included. JSON exports retain record type and provenance for included synthetic records; readable exports label them explicitly.
- Model conversion and SQLite persistence consume the full history, not either display projection. Readable exports are not lossless runtime checkpoints.
- SQL keyword searches and batch-export list counts use `READABLE_HISTORY_MESSAGE_SQL` to exclude runtime patches without dropping legacy rows with no metadata. WebMCP message pagination filters the readable history before counting or slicing.

New synthetic record types must define these policies and test persistence as well as each projection. Do not infer human authorship from `role === 'user'`.

## Sources and extension

Built-in sources cover skills, roots, agent directory, persona, diary, external tools, page tools, captured page context, registered bash commands, conversation identity, date, and mode. Skills and other collections use entry-level diffs; document-like values use a scalar replacement.

Add a source through `AgentLoopConfig.contextSources`:

```ts
contextSources: [{
  id: 'environment:services',
  async collect() {
    const snapshot = await readAuthoritativeServiceState()
    if (!snapshot.available) return undefined
    return Object.fromEntries(snapshot.services.map(service => [
      service.id, `${service.name}: ${service.status}`,
    ]))
  },
}]
```

A source needs no knowledge of model APIs, SQLite, retries, or compression. Source IDs must be unique. Caller permissions remain enforced by tool execution; a context update never grants authority.

## Epochs and compression

A model/provider route, fixed prompt, or native schema change creates an explicit new epoch. Dynamic state changes do not. Native bash descriptions exclude registered command manuals; those are supplied by the bash-commands source.

Compaction leaves the audit history intact and appends a summary. The next request reintroduces a full snapshot for every known source, including temporarily unavailable ones, before sending subsequent deltas. Context state is not entrusted to an LLM-generated summary. New summaries retain an exact message-ID boundary, avoiding timestamp collisions; old sessions retain timestamp fallback compatibility. The journal's sequence and the existing SQLite message sequence provide ordering without a new storage engine.

Page captures are bound to the user's send operation. Same-URL content is captured again and deduplicated by content. Historical inline page captures remain readable; new captures use the context journal.

## Verification and limits

Tests exercise 12/100/12 transitions, coalescing, reorder stability, source isolation, empty vs unavailable, corruption rejection, persistence round trips, failed durable admission, same-epoch request-prefix equality, resume, and compaction rebasing.

The guarantee concerns application-owned context and declarations. Actual provider cache hits also depend on its cache lifetime, routing, and protocol serialization. Editing history or changing the request envelope can break prefix reuse intentionally. Journals currently replay from retained audit history rather than a separate checkpoint index; add indexed checkpoints only if measured session sizes justify them.
