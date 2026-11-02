/**
 * Shared constants for the WebMCP package cross-context lock. This module
 * has NO imports so both the extension (background / management page) and
 * the web app (settings installer) can depend on it from any bundler
 * configuration.
 */

/** chrome.storage.local key prefix holding a package-operation lease. */
export const USER_PACKAGE_LOCK_KEY_PREFIX = 'webmcp_package_lock_'
