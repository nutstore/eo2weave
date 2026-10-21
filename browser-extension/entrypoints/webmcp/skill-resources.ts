import { createResourceProvider } from './resource-provider'

const bundled = import.meta.glob<string>('../../skills/**/*.{md,txt,py,js,json,yaml,yml,ts,html,css,sh,csv,svg}', {
  query: '?raw', import: 'default', eager: true,
})
const files = new Map(Object.entries(bundled).map(([path, content]) => [
  path.slice('../../skills/'.length), new TextEncoder().encode(content),
]))
const provider = createResourceProvider([...files.keys()], async path => files.get(path)!.slice())

/** Extension-owned skills are versioned and shipped with the extension. */
export async function getExtensionSkillStorage() { return provider }
