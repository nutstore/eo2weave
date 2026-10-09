/** Shared guest API for run_code and extension-hosted adapter workflows. */
export const TOOL_BINDINGS_SETUP = `
globalThis.tools = Object.freeze(Object.fromEntries(toolNames.map(name => [name, args => invokeTool(name, args)])));
const formatLog = value => { if (typeof value === 'string') return value; try { return JSON.stringify(value) ?? String(value); } catch { return String(value); } };
globalThis.console = Object.freeze(Object.fromEntries(['log', 'info', 'warn', 'error'].map(name => [name, (...args) => { void writeLog(args.map(formatLog).join(' ')); }])));
`
