import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const buildId = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || process.env.npm_package_version || 'dev'

// ─── Browser extension "latest version" ────────────────────────────────────
// The web build ships the browser extension (prepare-static-assets.mjs builds
// browser-extension and copies dist/chrome-mv3 into public/extension), so the
// extension's package.json version IS the latest installable version. Read it
// directly instead of requiring EXTENSION_LATEST_VERSION to be set manually in
// every build environment (it never was, so the settings page showed "0.0.0"
// and the outdated-extension banner could never trigger). The env var still
// wins when explicitly set (e.g. to pin a different version during rollout).
const extensionLatestVersion =
  process.env.EXTENSION_LATEST_VERSION ||
  JSON.parse(
    readFileSync(path.resolve(dirname, '..', 'browser-extension', 'package.json'), 'utf8'),
  ).version ||
  '0.0.0'

// ─── Deployment region (build-time required) ─────────────────────────────
// The domestic (weave.eo2suite.cn) and international (weave.eo2suite.com)
// sites are BUILT separately; NEXT_PUBLIC_DEPLOY_REGION is inlined into each
// build at compile time. Production builds MUST set it explicitly so a
// misconfigured CI job fails fast instead of silently shipping the default
// region's language to the wrong domain.
//   NEXT_PUBLIC_DEPLOY_REGION=cn      → domestic build (Chinese privacy policy)
//   NEXT_PUBLIC_DEPLOY_REGION=global  → international build (English privacy policy)
const DEPLOY_REGION_VALUES = ['cn', 'global']
if (
  process.env.NODE_ENV === 'production' &&
  !DEPLOY_REGION_VALUES.includes(process.env.NEXT_PUBLIC_DEPLOY_REGION)
) {
  throw new Error(
    [
      '[next.config] NEXT_PUBLIC_DEPLOY_REGION is required for production builds.',
      `Expected one of: ${DEPLOY_REGION_VALUES.map((v) => `'${v}'`).join(' | ')} (got ${JSON.stringify(process.env.NEXT_PUBLIC_DEPLOY_REGION)}).`,
      "Set it in the build environment: cn for the domestic deployment (weave.eo2suite.cn), global for the international one (weave.eo2suite.com).",
      'Local dev is exempt and defaults to global (English).',
    ].join('\n')
  )
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Project and workspace IDs live in browser OPFS/SQLite and are resolved by
  // runtime App Router routes. Do not use `output: 'export'`: arbitrary local
  // IDs cannot be enumerated at build time.
  outputFileTracingRoot: path.resolve(dirname, '..'),
  // Produce a self-contained Node server for the overseas AKS image. This
  // preserves the normal `.next` output used by the domestic EdgeOne build,
  // while adding `.next/standalone` for Docker/Kubernetes packaging.
  output: 'standalone',
  reactStrictMode: true,
  // Linting remains an explicit repository check. The existing application has
  // a broader legacy ESLint baseline, so it must not prevent runtime builds.
  eslint: {
    ignoreDuringBuilds: true,
  },
  // Required for @sqlite.org/sqlite-wasm OPFS VFS (crossOriginIsolated → SharedArrayBuffer/Atomics).
  // Provider configurations may repeat these headers, but runtime responses
  // must also be correct on a provider-neutral Next host.
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
        ],
      },
    ]
  },
  transpilePackages: [
    '@creatorweave/config',
    '@creatorweave/i18n',
    '@creatorweave/quickjs-runtime',
    '@creatorweave/shared',
    '@creatorweave/skills-system',
    '@creatorweave/ui',
  ],
  env: {
    NEXT_PUBLIC_APP_BUILD_ID: buildId,
    NEXT_PUBLIC_APP_VERSION: process.env.npm_package_version || '0.0.0',
    NEXT_PUBLIC_EXTENSION_LATEST_VERSION: extensionLatestVersion,
    NEXT_PUBLIC_JIANGUOYUN_AI_BASE_URL:
      process.env.NEXT_PUBLIC_JIANGUOYUN_AI_BASE_URL || '',
    NEXT_PUBLIC_JIANGUOYUN_AI_CLIENT_ID:
      process.env.NEXT_PUBLIC_JIANGUOYUN_AI_CLIENT_ID || '',
  },
  webpack(config, { webpack, isServer }) {
    // This client-heavy application produces a multi-gigabyte persistent
    // webpack cache; disable it so builds remain viable in
    // constrained CI and local disk environments.
    config.cache = false
    config.module.rules.push({
      resourceQuery: /raw/,
      type: 'asset/source',
    })

    if (isServer) {
      // monaco-editor reads `window` at module scope, so evaluating it in the
      // SSR/prerender bundle throws "window is not defined". The app is fully
      // client-rendered, so the server build never needs the real package.
      // Rewrite EVERY monaco request — bare specifier AND deep ESM worker
      // paths (monaco-editor/esm/vs/...) — to an empty stub. The replacement
      // plugin is required because object-form resolve.alias cannot remap
      // sub-path requests to a single file.
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(
          /^monaco-editor(?:\/|$)/,
          path.join(dirname, 'shims/monaco-editor.server.ts')
        )
      )
      // fall through: server bundles still need the node:zlib replacement and
      // fs/path/process fallbacks below — do NOT return early here.
    }

    // `just-bash` intentionally leaves node:zlib external in its browser
    // bundle. Webpack treats the node: prefix as a URI scheme before normal
    // aliases are applied, so replace the request at the module-factory stage.
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(
        /^node:zlib$/,
        path.join(dirname, 'shims/node-zlib.ts'),
      ),
    )

    // Workspace packages use `@/…` for their own `src` roots, while the web
    // app uses it for web/. Resolve both forms explicitly from the issuer.
    const packagesDir = path.resolve(dirname, '../packages')
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(/^@\//, (resource) => {
        const relativeContext = path.relative(packagesDir, resource.context)
        if (!relativeContext.startsWith('..') && !path.isAbsolute(relativeContext)) {
          const [packageName] = relativeContext.split(path.sep)
          if (packageName) {
            resource.request = path.join(packagesDir, packageName, 'src', resource.request.slice(2))
            return
          }
        }

        resource.request = path.join(dirname, resource.request.slice(2))
      })
    )

    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      'node:zlib': path.join(dirname, 'shims/node-zlib.ts'),
      zlib: path.join(dirname, 'shims/node-zlib.ts'),
      '@mongodb-js/zstd': false,
    }
    config.resolve.fallback = {
      ...(config.resolve.fallback || {}),
      fs: false,
      path: false,
      process: false,
    }
    return config
  },
}

export default nextConfig
