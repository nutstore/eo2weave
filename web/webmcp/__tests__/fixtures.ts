export const source = `export default [{
  description: 'Read', inputSchema: { type: 'object' }, outputSchema: { type: 'string' },
  inspect() { return { status: 'ready' } }, run() { return 'title' }
}]`
export const manifest = {
  id: 'com.example.tools', version: '1.0.0', description: 'Example tools',
  tools: [{ name: 'read-title', description: 'Read title', urlRegex: '^https://example\\.com/articles(?:/[^?#]*)?(?:\\?[^#]*)?(?:#.*)?$', path: 'read-title.js' }],
}
export const pkg = { manifest, sources: { 'read-title.js': source } }
