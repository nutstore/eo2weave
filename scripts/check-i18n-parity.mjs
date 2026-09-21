#!/usr/bin/env node
// i18n key-parity check: every namespace file under
// packages/i18n/src/locales/<locale>/ must expose the SAME flattened key set
// in all four locales (zh-CN, en-US, ja-JP, ko-KR). A missing key silently
// falls back to DEFAULT_LOCALE (zh-CN), so users of other locales see Chinese
// text — this check catches that at CI time instead.
//
// Run from repo root: node scripts/check-i18n-parity.mjs
// Exit 0 = parity, exit 1 = differences found.
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDirectory, '..')
// typescript is a dependency of packages/i18n — resolve from there so the
// script does not depend on where pnpm hoisted it.
const require = createRequire(path.join(projectRoot, 'packages/i18n/package.json'))
const ts = require('typescript')

const LOCALES_DIR = path.join(projectRoot, 'packages/i18n/src/locales')
const LOCALES = ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']

// Explicitly allowlisted asymmetric keys. Anything listed here is skipped by
// the parity check on purpose (e.g. a locale-specific doc note that must NOT
// exist in the other locales). Keep entries as 'locale/namespace:dotted.key'.
// Wildcards: 'namespace:prefix.*' exempts a whole subtree in all locales.
const EXCEPTIONS = [
  // Dead keys: defined in zh-CN/ja-JP/ko-KR skills.ts but referenced nowhere in
  // web/ (the trigger-keyword input placeholder/help were dropped from the UI in
  // an earlier refactor; en-US never had them). Listed here instead of deleting
  // from three locales — deletion is a separate cleanup decision.
  'skills:triggerKeywordsPlaceholder',
  'skills:triggerKeywordsHelp',
]

function flatten(value, prefix = '', out = []) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      const dotted = prefix ? `${prefix}.${key}` : key
      out.push(dotted)
      flatten(child, dotted, out)
    }
  }
  return out
}

// Locale files are `export const ns = { ... } as const` object literals.
// Evaluate the literal statically (no code execution) and merge every
// top-level declaration of the file.
function parseFile(filePath) {
  const source = readFileSync(filePath, 'utf8')
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true)
  const merged = {}
  const visit = (expression) => {
    if (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isParenthesizedExpression(expression)) {
      return visit(expression.expression)
    }
    if (ts.isObjectLiteralExpression(expression)) {
      const object = {}
      for (const property of expression.properties) {
        if (ts.isPropertyAssignment(property)) {
          const name = property.name.getText(sourceFile).replace(/^['"`]|['"`]$/g, '')
          object[name] = visit(property.initializer)
        } else if (ts.isSpreadAssignment(property)) {
          Object.assign(object, visit(property.expression))
        }
      }
      return object
    }
    return '<expr>'
  }
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.initializer) Object.assign(merged, visit(declaration.initializer))
      }
    }
  }
  return merged
}

function isException(locale, namespace, key) {
  return EXCEPTIONS.some((rule) => {
    const ruleLocale = rule.includes('/') ? rule.split('/')[0] : null
    const rest = ruleLocale ? rule.slice(rule.indexOf('/') + 1) : rule
    if (ruleLocale && ruleLocale !== locale) return false
    const colon = rest.indexOf(':')
    if (colon === -1) return false
    const ruleNamespace = rest.slice(0, colon)
    const ruleKey = rest.slice(colon + 1)
    if (ruleNamespace !== namespace) return false
    if (ruleKey.endsWith('.*')) return key.startsWith(ruleKey.slice(0, -1))
    return ruleKey === key
  })
}

const namespaces = readdirSync(path.join(LOCALES_DIR, LOCALES[0]))
  .filter((file) => file.endsWith('.ts') && file !== 'index.ts')

let problems = 0
for (const namespace of namespaces) {
  const keySets = {}
  for (const locale of LOCALES) {
    const filePath = path.join(LOCALES_DIR, locale, namespace)
    try {
      keySets[locale] = new Set(flatten(parseFile(filePath)))
    } catch (error) {
      console.error(`✖ ${locale}/${namespace}: failed to parse — ${error.message}`)
      problems++
      keySets[locale] = new Set()
    }
  }

  const missing = []
  for (const locale of LOCALES) {
    for (const key of keySets[locale]) {
      if (isException(locale, namespace.replace(/\.ts$/, ''), key)) continue
      for (const other of LOCALES) {
        if (other !== locale && !keySets[other].has(key)) {
          missing.push(`${other} is missing "${key}" (defined in ${locale})`)
        }
      }
    }
  }

  if (missing.length > 0) {
    problems += missing.length
    console.error(`\n✖ ${namespace} — ${missing.length} key(s) out of parity:`)
    for (const entry of missing) console.error(`    ${entry}`)
  }
}

if (problems > 0) {
  console.error(`\n❌ i18n key-parity check FAILED: ${problems} problem(s).`)
  console.error('   Add the missing keys to every locale, or document an')
  console.error('   intentional exception in EXCEPTIONS in scripts/check-i18n-parity.mjs.')
  process.exit(1)
}

console.log(`✅ i18n key-parity check passed: ${namespaces.length} namespaces × ${LOCALES.length} locales in sync.`)
