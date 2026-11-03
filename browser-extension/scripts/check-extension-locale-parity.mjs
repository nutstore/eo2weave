#!/usr/bin/env node
// Extension locale key-parity check (issue #143).
//
// `chrome.i18n.getMessage()` returns an EMPTY STRING for a key that the
// active locale does not define — the page then renders a blank label with
// no error anywhere. The extension ships two locales (`en` and `zh_CN`),
// so a key present in one but missing in the other means one of the two
// languages silently loses that string.
//
// The check asserts:
//   1. both locales expose the SAME key set;
//   2. both locales declare the SAME placeholders per key (a `$PARAM$`
//      declared in one locale but not in the other breaks the substitution
//      for that locale only);
//   3. no message uses the web app's `{param}` placeholder form — the
//      extension's chrome.i18n only understands `$PARAM$`.
//
// Run from the repo root or from browser-extension/:
//   node scripts/check-extension-locale-parity.mjs
// Exit 0 = parity, exit 1 = differences found.
//
// The wxt `build:before` hook imports `checkExtensionLocaleParity()` and
// fails the build on drift.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const extensionRoot = path.resolve(scriptDirectory, '..')
const localesDir = path.join(extensionRoot, 'public', '_locales')

function readMessages(locale) {
  const file = path.join(localesDir, locale, 'messages.json')
  return JSON.parse(readFileSync(file, 'utf8'))
}

/**
 * Verify the locale parity. Throws with a readable report when the locales
 * drifted apart; returns the key count of the reference locale otherwise.
 */
export function checkExtensionLocaleParity() {
  if (!existsSync(localesDir)) {
    throw new Error(`Extension locales directory not found: ${localesDir}`)
  }
  const locales = readdirSync(localesDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()

  if (locales.length < 2) {
    throw new Error(`Expected at least two extension locales, found: ${locales.join(', ')}`)
  }

  const tables = Object.fromEntries(locales.map(locale => [locale, readMessages(locale)]))
  const reference = locales[0]
  let problems = 0

  for (const locale of locales) {
    const table = tables[locale]
    const referenceKeys = new Set(Object.keys(tables[reference]))
    const keys = new Set(Object.keys(table))

    const missing = [...referenceKeys].filter(key => !keys.has(key))
    const extra = [...keys].filter(key => !referenceKeys.has(key))
    if (missing.length || extra.length) {
      problems += missing.length + extra.length
      console.error(`\n✖ ${locale} vs ${reference} — ${missing.length} missing / ${extra.length} extra key(s):`)
      for (const key of missing) console.error(`    ${locale} is missing "${key}"`)
      for (const key of extra) console.error(`    ${locale} has an extra key "${key}"`)
    }

    for (const [key, entry] of Object.entries(table)) {
      const referenceEntry = tables[reference][key]
      if (!referenceEntry) continue
      const declared = Object.keys(entry.placeholders ?? {}).sort()
      const referenceDeclared = Object.keys(referenceEntry.placeholders ?? {}).sort()
      if (declared.join(',') !== referenceDeclared.join(',')) {
        problems++
        console.error(`\n✖ ${locale}/${key} — placeholder mismatch:`)
        console.error(`    ${reference}: [${referenceDeclared.join(', ')}]`)
        console.error(`    ${locale}: [${declared.join(', ')}]`)
      }
      // The web app's `{param}` form does NOT work with chrome.i18n.
      if (/\{(\w+)\}/.test(entry.message)) {
        problems++
        console.error(`\n✖ ${locale}/${key} — uses the web app's {param} placeholder form; chrome.i18n needs $PARAM$.`)
      }
      // Every `$NAME$` used in the message must be declared.
      const used = [...entry.message.matchAll(/\$([A-Z_]+)\$/g)].map(match => match[1].toLowerCase())
      const undeclared = used.filter(name => !declared.includes(name))
      if (undeclared.length) {
        problems++
        console.error(`\n✖ ${locale}/${key} — undeclared placeholder(s): ${undeclared.join(', ')}`)
      }
    }
  }

  if (problems > 0) {
    console.error(`\n❌ Extension locale key-parity check FAILED: ${problems} problem(s).`)
    console.error('   Add the missing keys/placeholders to every locale under')
    console.error('   browser-extension/public/_locales/<locale>/messages.json.')
    throw new Error(`Extension locale key-parity check failed: ${problems} problem(s)`)
  }

  const counts = locales.map(locale => `${locale}=${Object.keys(tables[locale]).length}`).join(' ')
  console.log(`✅ Extension locale key-parity check passed: ${counts}`)
  return Object.keys(tables[reference]).length
}

// CLI entry: `node scripts/check-extension-locale-parity.mjs`.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    checkExtensionLocaleParity()
  } catch {
    process.exit(1)
  }
}
