/**
 * sessionStorage / localStorage keys shared across store + diagnostics layers.
 *
 * Kept in a dependency-free module so both `store/project.store` (writer) and
 * `storage/diagnostics` (reader) can reference the exact same key without
 * importing each other's module graphs.
 */
export const PROJECT_STORE_INIT_ERROR_KEY = 'creatorweave:project-store-init-error'
