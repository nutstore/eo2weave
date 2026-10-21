/// <reference types="wxt/vite-builder-env" />

// Package files are runtime source text, never imported as executable modules.
const bundled = import.meta.glob<string>('../../builtin-webmcp/**/*.{js,json}', {
  query: '?raw',
  import: 'default',
  eager: true,
})

export const builtinResources: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(bundled).map(([path, source]) => [path.slice('../../builtin-webmcp/'.length), source]),
)
