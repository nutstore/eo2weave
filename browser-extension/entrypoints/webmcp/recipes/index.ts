// ============================================================
// Recipe registry — all built-in recipes.
// The management page (recipes.html) reads metadata from here;
// the MAIN-world injector imports implementations lazily so a
// non-jmail page never pulls the jmail tool code into its bundle
// evaluation path (WXT bundles each content script separately,
// but a single registry module keeps the mapping explicit).
// ============================================================

import type { WebMCPRecipe } from './types'
import { jmailRecipe } from './jmail-world'
import { jmessageRecipe } from './jmessage-world'
import { doubanMovieRecipe, doubanSearchRecipe } from './douban-movie'
import { xiaohongshuRecipe } from './xiaohongshu'

export { ENABLED_RECIPES_STORAGE_KEY } from './types'
export type { WebMCPRecipe, WebMCPRecipeTool } from './types'

export const recipes: WebMCPRecipe[] = [jmailRecipe, jmessageRecipe, doubanMovieRecipe, doubanSearchRecipe, xiaohongshuRecipe]

/** Does `pathname` fall inside one of the recipe's path prefixes?
 *  Undefined prefixes = all paths. '/' matches only the exact root
 *  (so the jmail archive recipe does not leak onto /messages,
 *  /photos, /flights …). Other prefixes match on segment boundaries
 *  ('/activity' covers '/activity/2014'). */
function pathMatches(recipe: WebMCPRecipe, pathname: string): boolean {
  if (!recipe.pathPrefixes) return true
  return recipe.pathPrefixes.some((prefix) => {
    if (prefix === '/') return pathname === '/'
    return pathname === prefix || pathname.startsWith(prefix + '/')
  })
}

/** All recipes for a hostname (may be several: one host, several apps). */
export function findRecipesForHostname(hostname: string): WebMCPRecipe[] {
  return recipes.filter((r) => r.hostname === hostname)
}

/** The single recipe active at a location, or undefined. */
export function findRecipeForLocation(hostname: string, pathname: string): WebMCPRecipe | undefined {
  return findRecipesForHostname(hostname).find((r) => pathMatches(r, pathname))
}
