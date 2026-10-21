/** SQL counterpart of the readable-history projection; `m` is a query-local alias. */
export const READABLE_HISTORY_MESSAGE_SQL =
  "COALESCE(json_extract(NULLIF(m.meta_json, ''), '$.kind'), '') <> 'context_update'"
