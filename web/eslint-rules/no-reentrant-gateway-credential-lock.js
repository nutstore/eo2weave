const path = require('node:path')

const authEntries = new Set([
  'resolveGatewayDispatchCredential',
  'getValidAccessToken',
  'isGatewayAccessTokenCurrent',
  'hasStoredSession',
  'refreshAccessTokenWithStatus',
  'refreshAccessTokenWithStatusImpl',
  'forceRefreshAccessToken',
  'logoutGateway',
  'invalidateGatewayAccessToken',
  'loadStoredTokensWithFallback',
  'clearStoredTokens',
  'inspectPriorSession',
  'withGatewayRefreshLock',
])
const entries = {
  'agent/providers/gateway-credential-lock': new Set(['withGatewayCredentialLock']),
  'agent/providers/gateway-dispatch-key': new Set(['resolveDispatchApiKey']),
  'agent/providers/llm-gateway-auth': authEntries,
  'agent/providers/llm-gateway-provider': new Set([
    ...authEntries,
    'prepareGatewayModels',
    'updateGatewayModels',
    'fetchGatewayRateLimits',
  ]),
  'lib/gateway-login': new Set(['applyGatewayLoginTokens', 'applyGatewayLoginTokensInner']),
}
const functions = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'])
const webRoot = path.resolve(__dirname, '..')

// A deliberately finite boundary check, not a call graph or async-context detector.
// Indirect helpers still need review. Import provenance avoids unrelated names.
module.exports = {
  meta: {
    type: 'problem',
    docs: { description: 'Keep gateway credential resolution outside credential commits' },
    schema: [],
    messages: {
      resolveBeforeLock:
        '{{offender}} can acquire the gateway credential lock; resolve before entering the lock commit.',
    },
  },
  create(context) {
    const source = context.getSourceCode()
    const filename = context.getFilename()
    const calls = []
    const functionNodes = []

    function moduleKey(absolute) {
      return path
        .relative(webRoot, absolute)
        .replace(/\\/g, '/')
        .replace(/\.(?:tsx?|jsx?)$/, '')
    }
    const ownModule = moduleKey(filename)
    function importModule(value) {
      if (typeof value !== 'string') return null
      if (value.startsWith('@/')) return value.slice(2).replace(/\.(?:tsx?|jsx?)$/, '')
      if (value.startsWith('.')) return moduleKey(path.resolve(path.dirname(filename), value))
      return null
    }
    function variableFor(identifier) {
      let scope = source.getScope(identifier)
      while (scope) {
        const variable = scope.set.get(identifier.name)
        if (variable) return variable
        scope = scope.upper
      }
      return null
    }
    function propertyName(member) {
      if (!member.computed && member.property.type === 'Identifier') return member.property.name
      return member.property.value
    }
    function memberOrigin(origin, name) {
      if (!origin) return null
      if (origin.name === '*') return { module: origin.module, name }
      if (
        origin.module === 'agent/providers/credential-state' &&
        origin.name === 'credentialRegistry' &&
        name === 'resolve'
      ) {
        return { module: origin.module, name: 'credentialRegistry.resolve' }
      }
      if (
        origin.module === 'store/settings.store' &&
        origin.name === 'settings' &&
        name === 'checkHasApiKey'
      ) {
        return { module: origin.module, name }
      }
      return null
    }
    function originOf(node, seen = new Set()) {
      if (!node) return null
      if (
        node.type === 'AwaitExpression' ||
        node.type === 'ChainExpression' ||
        node.type === 'TSAsExpression'
      ) {
        return originOf(node.argument || node.expression, seen)
      }
      if (node.type === 'ImportExpression') {
        return { module: importModule(node.source.value), name: '*' }
      }
      if (node.type === 'MemberExpression') {
        return memberOrigin(originOf(node.object, seen), propertyName(node))
      }
      if (
        node.type === 'CallExpression' &&
        node.callee.type === 'MemberExpression' &&
        propertyName(node.callee) === 'getState'
      ) {
        const store = originOf(node.callee.object, seen)
        if (store?.module === 'store/settings.store' && store.name === 'useSettingsStore') {
          return { module: store.module, name: 'settings' }
        }
      }
      if (node.type !== 'Identifier') return null
      const variable = variableFor(node)
      if (!variable || seen.has(variable)) return null
      seen.add(variable)
      const def = variable.defs[0]
      if (!def) return null
      if (def.type === 'ImportBinding') {
        return {
          module: importModule(def.parent.source.value),
          name: def.node.type === 'ImportNamespaceSpecifier' ? '*' : def.node.imported?.name,
        }
      }
      if (def.type === 'Variable') {
        const origin = originOf(def.node.init, seen)
        if (def.node.id.type === 'Identifier') return origin
        if (def.node.id.type === 'ObjectPattern') {
          const property = def.node.id.properties.find(
            (item) => item.type === 'Property' && item.value === def.name
          )
          if (property) return memberOrigin(origin, property.key.name || property.key.value)
        }
      }
      // Private auth/login entry points only have this meaning in their owning
      // module scope. A local parameter or helper with the same name is safe.
      if (
        def.type === 'FunctionName' &&
        variable.scope.type === 'module' &&
        entries[ownModule]?.has(node.name)
      ) {
        return { module: ownModule, name: node.name }
      }
      return null
    }
    function isLock(call) {
      const origin = originOf(call.callee)
      return (
        origin?.module === 'agent/providers/gateway-credential-lock' &&
        origin.name === 'withGatewayCredentialLock'
      )
    }
    function callbackFunction(node) {
      if (!node) return null
      if (functions.has(node.type)) return node
      if (node.type !== 'Identifier') return null
      const def = variableFor(node)?.defs[0]
      if (def?.type === 'FunctionName') return def.node
      if (def?.type === 'Variable' && functions.has(def.node.init?.type)) return def.node.init
      return null
    }
    function functionName(node) {
      return (
        node.id?.name ||
        (node.parent.type === 'VariableDeclarator' ? node.parent.id.name : '') ||
        ''
      )
    }
    function insideLocked(node, locked) {
      let parent = node.parent
      while (parent) {
        if (locked.has(parent)) return true
        parent = parent.parent
      }
      return false
    }
    function isExplicitlyQueued(call) {
      let node = call
      // An explicit void documents that the queued work is not awaited.
      while (
        node.parent?.type === 'MemberExpression' &&
        node.parent.object === node &&
        node.parent.parent?.type === 'CallExpression' &&
        node.parent.parent.callee === node.parent
      ) {
        node = node.parent.parent
      }
      const parent = node.parent
      return parent?.type === 'UnaryExpression' && parent.operator === 'void'
    }
    return {
      CallExpression(node) {
        calls.push(node)
      },
      ':function'(node) {
        functionNodes.push(node)
      },
      'Program:exit'() {
        const locked = new Set(
          functionNodes.filter((node) => functionName(node).endsWith('Locked'))
        )
        for (const call of calls) {
          if (isLock(call)) {
            const callback = callbackFunction(call.arguments[0])
            if (callback) locked.add(callback)
          }
        }
        for (const call of calls) {
          if (!insideLocked(call, locked)) continue
          const origin = originOf(call.callee)
          if (!origin) continue
          const offender = origin.name
          const forbidden =
            entries[origin.module]?.has(offender) ||
            (origin.module === 'agent/providers/credential-state' &&
              offender === 'credentialRegistry.resolve') ||
            (origin.module === 'store/settings.store' && offender === 'checkHasApiKey')
          if (!forbidden || (isLock(call) && isExplicitlyQueued(call))) continue
          context.report({ node: call, messageId: 'resolveBeforeLock', data: { offender } })
        }
      },
    }
  },
}
