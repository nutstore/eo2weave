// Express reverse proxy for /blog on Maker. The private WordPress origin
// requires separate connection IP, TLS SNI and HTTP Host values; plain fetch()
// cannot express this. Origin credentials are supplied by environment or CI.

import https from 'node:https';
import { pipeline } from 'node:stream/promises';
import { BLOG_ORIGIN as BUNDLED_ORIGIN } from './blog-origin.generated.js';

const ORIGIN_PORT = 443;
const PUBLIC_HOST = 'weave.eo2suite.cn';
const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;

let originConfigCache = null;

// Prefer runtime environment variables, then the module injected by CI and
// bundled with the function. Resolve lazily so missing credentials return 502
// instead of crashing module initialization. Never commit real origin values.
function originConfig() {
  if (originConfigCache) return originConfigCache;
  const envIp = process.env.BLOG_ORIGIN_IP;
  const envHost = process.env.BLOG_ORIGIN_HOST;
  // A half-set runtime config is a deployment error: accepting the bundled pair
  // instead would route traffic to an origin nobody configured.
  if (envIp !== undefined || envHost !== undefined) {
    if (!envIp || !envHost) {
      throw new Error('blog proxy misconfigured: set both BLOG_ORIGIN_IP and BLOG_ORIGIN_HOST');
    }
    originConfigCache = { ip: envIp, host: envHost };
    return originConfigCache;
  }
  if (BUNDLED_ORIGIN?.ip && BUNDLED_ORIGIN?.host) {
    originConfigCache = {
      ip: String(BUNDLED_ORIGIN.ip),
      host: String(BUNDLED_ORIGIN.host),
    };
    return originConfigCache;
  }
  throw new Error(
    'blog proxy is not configured: set BLOG_ORIGIN_IP and BLOG_ORIGIN_HOST (Maker console env vars), or inject blog-origin.generated.js via CI credentials',
  );
}

const MAX_BODY_BYTES = 6 * 1024 * 1024; // Maker Cloud Functions request body limit
const BODY_READ_TIMEOUT_MS = 10000; // whole-body deadline; a trickle never trips a socket timeout
const ORIGIN_TIMEOUT_MS = 25000; // below the 60s maxDuration in edgeone.json

// Hop-by-hop headers must not be forwarded in either direction (RFC 7230 6.1).
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-authenticate',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// Caller-supplied forwarding metadata must never reach the origin: plugins that
// allowlist or rate-limit on the client address would otherwise trust a value
// the caller invented. Covers the whole `x-forwarded-*` family, not a list that
// a new header name can outgrow.
export function isCallerForwardingHeader(name) {
  return (
    name === 'forwarded' ||
    name === 'x-real-ip' ||
    name === 'x-client-ip' ||
    name === 'true-client-ip' ||
    name === 'cf-connecting-ip' ||
    name.startsWith('x-forwarded-')
  );
}

// Headers nominated by a message's own Connection header are hop-by-hop for
// that message even though they are not in the fixed list above (RFC 7230 6.1).
export function connectionNominated(headers) {
  const nominated = new Set();
  const value = headers.connection;
  if (typeof value !== 'string') return nominated;
  for (const token of value.split(',')) {
    const name = token.trim().toLowerCase();
    if (name) nominated.add(name);
  }
  return nominated;
}

export function isUnderBlogPath(pathname) {
  return pathname === '/blog' || pathname.startsWith('/blog/');
}

// `new URL` normalizes encoded dot segments but leaves encoded separators
// (`%2f`, `%5c`) intact, so `isUnderBlogPath` alone accepts paths that an origin
// decoding them would route outside the proxied prefix.
//
// Each segment is decoded on its own to a fixed point: decoding the whole path
// in one call lets a single malformed escape (`%zz`) abort the chain before the
// traversal segment is decoded, which would validate a shallower value than the
// origin sees. A segment that cannot be decoded further keeps its last
// decodable value — that is the deepest value any decoder reaches, so a literal
// `%` (e.g. `/blog/100%25-coverage`) still passes.
function decodeSegment(segment) {
  let decoded = segment;
  for (let pass = 0; pass < 32; pass += 1) {
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return decoded;
    }
    if (next === decoded) return decoded;
    decoded = next;
  }
  // Still changing after 32 layers: fail closed.
  return null;
}

export function isSafeOriginPath(pathname) {
  let value = pathname;
  let settled = false;
  for (let pass = 0; pass < 32; pass += 1) {
    const decoded = value.split(/[\\/]/).map(decodeSegment);
    // `null` marks a segment that never settles; treat the whole path as unsafe.
    if (decoded.some((segment) => segment === null)) return false;
    const next = decoded.join('/');
    if (next === value) {
      settled = true;
      break;
    }
    value = next;
  }
  if (!settled) return false;
  if (!isUnderBlogPath(value) || value.includes('\0')) return false;
  // Some origins and intermediaries treat a backslash as a path separator.
  return value.split(/[\\/]/).every((segment) => segment !== '.' && segment !== '..');
}

// Write to ServerResponse to preserve repeated Set-Cookie headers on Maker.
export async function handleRequest(request, response) {
  try {
    await proxyBlog(request, response);
  } catch (err) {
    // Do not log query strings, cookies, or request bodies.
    console.error('[blog-proxy] request failed', {
      method: request.method,
      path: request.url?.split('?')[0],
      code: err?.code,
      message: err?.message,
    });
    if (response.destroyed) return;
    if (response.headersSent) {
      response.destroy(err);
      return;
    }
    const status =
      err?.code === 'BLOG_ORIGIN_TIMEOUT' ? 504 : err?.code === 'BLOG_BODY_TIMEOUT' ? 408 : 502;
    // Never echo err.message: DNS/TLS failures embed the private origin address.
    // Operators get the detail from the function log, callers get a generic body.
    const message =
      status === 504
        ? 'Blog origin timed out'
        : status === 408
          ? 'Blog proxy request body timed out'
          : 'Blog origin unavailable';
    textResponse(response, status, message);
  }
}

async function proxyBlog(request, response) {
  // Maker removes /blog before invoking the framework, including for its root
  // route. Restore it here so upstream paths and query strings remain intact.
  const url = new URL(`/blog${request.url}`, PUBLIC_ORIGIN);
  // request.url is caller-controlled and `new URL` normalizes encoded dot
  // segments (`/blog/%2e%2e/admin` becomes `/admin`), which would let a request
  // escape the proxied prefix. Reject anything that no longer lands on /blog.
  if (url.origin !== PUBLIC_ORIGIN || !isUnderBlogPath(url.pathname) || !isSafeOriginPath(url.pathname)) {
    request.resume();
    // Close the socket once the 404 is flushed: a client that keeps sending
    // would otherwise hold the invocation until it reaches EOF.
    response.once('close', () => request.destroy());
    return textResponse(response, 404, 'blog proxy: path outside /blog');
  }
  const origin = originConfig();
  const method = (request.method ?? 'GET').toUpperCase();
  const originPath = normalizeOriginPath(url.pathname);

  let body = null;
  if (method !== 'GET' && method !== 'HEAD') {
    const declared = Number(request.headers['content-length'] ?? 0);
    if (declared > MAX_BODY_BYTES) {
      // Answer without draining: a client that keeps sending slowly would
      // otherwise hold the invocation after the 413 was written.
      textResponse(response, 413, 'blog proxy: payload exceeds the 6MB Maker function limit');
      response.once('close', () => request.destroy());
      return;
    }
    const chunks = [];
    let size = 0;
    // Bound the whole read, not socket inactivity: a client trickling bytes
    // keeps the socket busy and would otherwise hold the invocation open.
    const deadline = setTimeout(() => {
      request.destroy(
        Object.assign(new Error(`request body read timeout after ${BODY_READ_TIMEOUT_MS}ms`), {
          code: 'BLOG_BODY_TIMEOUT',
        }),
      );
    }, BODY_READ_TIMEOUT_MS);
    try {
      for await (const chunk of request) {
        size += chunk.length;
        // Answer as soon as the limit is crossed: draining an oversized chunked
        // upload would hold the invocation until the client reaches EOF.
        if (size > MAX_BODY_BYTES) {
          request.pause();
          textResponse(response, 413, 'blog proxy: payload exceeds the 6MB Maker function limit');
          response.once('close', () => request.destroy());
          return;
        }
        chunks.push(chunk);
      }
    } finally {
      clearTimeout(deadline);
    }
    body = Buffer.concat(chunks);
  }

  const headers = buildOriginRequestHeaders(request, url, body, origin);
  // Resolve relative redirects against the directory actually requested from
  // the origin, including any trailing slash restored above.
  const originUrl = new URL(originPath + url.search, PUBLIC_ORIGIN);
  await originRequest({ method, path: originPath + url.search, headers, body, origin, publicUrl: originUrl }, response);
}

function buildOriginRequestHeaders(request, url, body, origin) {
  const headers = {};
  const nominated = connectionNominated(request.headers);
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (nominated.has(lower)) continue;
    if (isCallerForwardingHeader(lower)) continue; // rebuilt from trusted values below
    if (lower === 'host') continue; // origin nginx requires its own vhost name
    if (lower === 'accept-encoding') continue; // forced to identity below
    if (lower === 'content-length') continue; // recomputed from the buffered body
    if (lower === 'expect') continue; // let node handle 100-continue itself
    headers[name] = value;
  }
  // Request uncompressed bytes and stream the origin response unchanged.
  headers['accept-encoding'] = 'identity';
  headers['host'] = origin.host;
  headers['x-forwarded-host'] = url.host;
  headers['x-forwarded-proto'] = 'https';
  if (body && body.length) headers['content-length'] = String(body.length);
  return headers;
}

function originRequest({ method, path, headers, body, origin, publicUrl }, response) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: origin.ip, // connect by IP: the origin has no public DNS
        port: ORIGIN_PORT,
        servername: origin.host, // TLS SNI — the piece fetch() cannot set
        path,
        method,
        headers,
        agent: false,
      },
      (res) => { bridgeResponse(res, response, method, publicUrl, origin).then(resolve, reject); },
    );
    req.setTimeout(ORIGIN_TIMEOUT_MS, () => {
      req.destroy(Object.assign(new Error(`origin timeout after ${ORIGIN_TIMEOUT_MS}ms`), {
        code: 'BLOG_ORIGIN_TIMEOUT',
      }));
    });
    // req.setTimeout only applies once the socket connects: an origin that
    // silently drops the SYN would otherwise run into the function's duration
    // limit instead of returning the intended 504. The timer must stop at
    // connect time — it bounds the handshake, not the whole transfer.
    const connectTimer = setTimeout(() => {
      req.destroy(Object.assign(new Error(`origin connect timeout after ${ORIGIN_TIMEOUT_MS}ms`), {
        code: 'BLOG_ORIGIN_TIMEOUT',
      }));
    }, ORIGIN_TIMEOUT_MS);
    const clearConnectTimer = () => clearTimeout(connectTimer);
    req.once('socket', (socket) => {
      if (socket.connecting) socket.once('connect', clearConnectTimer);
      else clearConnectTimer();
    });
    req.once('close', clearConnectTimer);
    req.on('error', reject);
    response.once('close', () => req.destroy(new Error('blog proxy client disconnected')));
    if (body && body.length) req.write(body);
    req.end();
  });
}

async function bridgeResponse(res, response, method, publicUrl, origin) {
  let status = res.statusCode ?? 502;
  if (status < 200 || status > 599) status = 502;

  const nominated = connectionNominated(res.headers);
  for (const [name, value] of Object.entries(res.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (nominated.has(lower)) continue;
    if (lower === 'location') {
      response.setHeader('location', rewriteLocation(value, publicUrl, origin.host));
      continue;
    }
    // Node exposes Set-Cookie as string[], including same-name cookies with
    // distinct paths. Forward the array in one call so none are overwritten.
    response.setHeader(name, value);
  }

  // Preserve the origin's cache policy. Never infer public cacheability from
  // URL paths or file extensions when the origin does not specify a policy.
  if (!response.hasHeader('cache-control')) {
    response.setHeader('cache-control', 'no-store');
  }

  const withoutBody = method === 'HEAD' || status === 204 || status === 304;
  response.statusCode = status;
  if (withoutBody) {
    res.resume();
    response.end();
    return;
  }
  await pipeline(res, response);
}

// Maker removes trailing slashes. Restore WordPress directory slashes on
// upstream requests to prevent redirect loops between the edge and origin.
function normalizeOriginPath(pathname) {
  if (pathname === '/blog') return '/blog/';
  if (pathname.endsWith('/')) return pathname;
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  const isFile = lastSegment.includes('.');
  const isRestApi = pathname.startsWith('/blog/wp-json');
  if (isFile || isRestApi) return pathname;
  return `${pathname}/`;
}

// Keep WordPress redirects on the public HTTPS host and remove directory
// slashes to match Maker's canonical URLs.
// Redirects must stay on the public host. Path-relative values (`wp-login.php`)
// resolve against the request that produced them: WordPress emits those from
// nested paths, and resolving against the site root drops the /blog prefix.
export function rewriteLocation(location, currentUrl, originHost) {
  if (!location) return location;
  try {
    const target = new URL(location, currentUrl ?? PUBLIC_ORIGIN);
    // `target.host` is lowercased by the URL parser; the configured origin host
    // may not be, and a case mismatch would leak the private origin hostname.
    const configuredHost = typeof originHost === 'string' ? originHost.toLowerCase() : '';
    if (target.host !== configuredHost && target.host !== PUBLIC_HOST) return location;
    target.protocol = 'https:';
    target.host = PUBLIC_HOST;
    target.port = '';
    if (target.pathname.length > 1) {
      target.pathname = target.pathname.replace(/\/+$/, '');
    }
    // The origin serves WordPress under /blog, so a root-relative redirect
    // (`/wp-login.php`) has to be mapped back under the proxied prefix —
    // outside it the service worker answers with the app shell instead.
    if (!isUnderBlogPath(target.pathname)) {
      target.pathname = target.pathname === '/' ? '/blog' : `/blog${target.pathname}`;
    }
    if (target.origin === PUBLIC_ORIGIN) {
      return `${target.pathname}${target.search}${target.hash}`;
    }
    return target.href;
  } catch {
    // keep the original value if it cannot be parsed as a URL
    return location;
  }
}

function textResponse(response, status, message) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(`${message}\n`);
}
