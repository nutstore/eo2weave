import type { JsonValue, RuntimeFailure } from '@creatorweave/quickjs-runtime'

/** Portable image bytes: external callers need no access to the producer's OPFS. */
export type ImageOutput = { type: 'image'; data: string; mimeType: string }
export type OutputPart = { type: 'text'; text: string } | ImageOutput
export type CodeRunResult =
  | { ok: true; value: JsonValue; output: OutputPart[] }
  | { ok: false; error: RuntimeFailure; output: OutputPart[] }

export const CODE_OUTPUT_MAX_BYTES = 6 * 1024 * 1024
export const CODE_OUTPUT_MAX_ITEMS = 1000

/** Helpers only construct the current execution's JSON output. */
export const CODE_OUTPUT_SETUP = `
(() => {
  let bytes = 0;
  let items = 0;
  const utf8Bytes = value => {
    let size = 0;
    for (const char of value) {
      const point = char.codePointAt(0);
      size += point <= 127 ? 1 : point <= 2047 ? 2 : point <= 65535 ? 3 : 4;
    }
    return size;
  };
  const append = part => {
    const nextBytes = bytes + utf8Bytes(__qjsJson(part));
    if (items + 1 > ${CODE_OUTPUT_MAX_ITEMS} || nextBytes > ${CODE_OUTPUT_MAX_BYTES}) {
      throw Object.assign(new Error('Execution output limit exceeded'), { code: 'JS_OUTPUT_LIMIT' });
    }
    emitEvent(part);
    bytes = nextBytes;
    items++;
  };
  const text = value => append({ type: 'text', text: typeof value === 'string' ? value : __qjsJson(value) });
  const image = value => {
    let data;
    if (typeof value === 'string') data = value;
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (typeof value.image_url === 'string') data = value.image_url;
      else if (value.type === 'image' && typeof value.data === 'string') data = value.data;
    }
    if (typeof data !== 'string' || !data) throw new TypeError('image() expects an image block or base64 data URL');
    if (/^https?:/i.test(data)) throw new TypeError('image() requires inline image bytes, not a remote URL');
    if (/^data:/i.test(data)) {
      const match = /^data:[^,]*;base64,([\\s\\S]*)$/i.exec(data);
      if (!match) throw new TypeError('image() requires a base64 data URL');
      data = match[1];
    }
    data = data.replace(/\\s+/g, '');
    if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new TypeError('Invalid image base64');
    const signatures = [
      ['image/png', /^iVBORw0KGg/], ['image/jpeg', /^[/]9j[/]/],
      ['image/gif', /^R0lGOD[dl]h/], ['image/webp', /^UklG.{8}RUJQ/],
    ];
    const signature = signatures.find(([, pattern]) => pattern.test(data.slice(0, 16)));
    if (!signature) throw new TypeError('image() only supports PNG, JPEG, GIF and WebP');
    append({ type: 'image', data, mimeType: signature[0] });
  };
  globalThis.text = text;
  globalThis.image = image;
  globalThis.output = Object.freeze({ forward(parts) {
    if (!Array.isArray(parts)) throw new TypeError('output.forward() expects output parts');
    for (const part of parts) {
      if (part?.type === 'image') image(part);
      else if (part?.type === 'text' && typeof part.text === 'string') text(part.text);
      else throw new TypeError('Invalid output part');
    }
  } });
  globalThis.console = Object.freeze(Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(name => [name, (...args) => {
    text(args.map(value => typeof value === 'string' ? value : __qjsJson(value)).join(' '));
  }])));
})();
`

/** Validate media without trusting MIME labels or fetching remote resources. */
export function imageMimeType(data: string): string | undefined {
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return undefined
  const signatures: Array<[string, RegExp]> = [
    ['image/png', /^iVBORw0KGg/], ['image/jpeg', /^\/9j\//],
    ['image/gif', /^R0lGOD[dl]h/], ['image/webp', /^UklG.{8}RUJQ/],
  ]
  return signatures.find(([, pattern]) => pattern.test(data.slice(0, 16)))?.[0]
}

export function isOutputPart(value: unknown): value is OutputPart {
  if (!value || typeof value !== 'object') return false
  const part = value as Record<string, unknown>
  return part.type === 'text'
    ? typeof part.text === 'string'
    : part.type === 'image' && typeof part.data === 'string' &&
      typeof part.mimeType === 'string' && imageMimeType(part.data) === part.mimeType
}

export function isCodeRunResult(value: unknown): value is CodeRunResult {
  if (!value || typeof value !== 'object') return false
  const result = value as Record<string, unknown>
  if (!Array.isArray(result.output) || !result.output.every(isOutputPart)) return false
  if (result.ok === true) return Object.hasOwn(result, 'value')
  if (result.ok !== false || !result.error || typeof result.error !== 'object') return false
  const error = result.error as Record<string, unknown>
  return typeof error.code === 'string' && typeof error.message === 'string'
}

/** Public JSON contract for callers that choose to return the complete execution result. */
export const CODE_RUN_RESULT_SCHEMA = {
  type: 'object',
  oneOf: [
    { properties: { ok: { const: true }, value: true, output: { $ref: '#/definitions/output' } }, required: ['ok', 'value', 'output'], additionalProperties: false },
    { properties: { ok: { const: false }, error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } }, required: ['code', 'message'] }, output: { $ref: '#/definitions/output' } }, required: ['ok', 'error', 'output'], additionalProperties: false },
  ],
  definitions: {
    output: {
      type: 'array', maxItems: CODE_OUTPUT_MAX_ITEMS,
      items: { oneOf: [
        { type: 'object', properties: { type: { const: 'text' }, text: { type: 'string' } }, required: ['type', 'text'], additionalProperties: false },
        { type: 'object', properties: { type: { const: 'image' }, data: { type: 'string', minLength: 1, pattern: '^[A-Za-z0-9+/]+={0,2}$' }, mimeType: { enum: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] } }, required: ['type', 'data', 'mimeType'], additionalProperties: false },
      ] },
    },
  },
} as const
