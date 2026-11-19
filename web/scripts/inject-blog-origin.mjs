// Rewrite the placeholder module blog-origin.generated.js with the real origin
// topology before `edgeone makers deploy` runs. Called from the Jenkins
// pipeline; the values come from Jenkins credentials, never from git.
//
// Why a JS module and not a data file: the Maker bundler compiles the function
// into a single index.mjs (cwd=/var/user) and does NOT copy includeFiles data
// into the runtime, so readFileSync fails with ENOENT. An imported module is
// inlined into the bundle by the bundler itself, which is guaranteed to work.
//
// Always overwrite the module so a reused workspace cannot retain credentials
// from an earlier build. Missing credentials produce empty placeholders;
// partially configured credentials also fail the build.
import { writeFileSync } from 'node:fs';

const ip = process.env.BLOG_ORIGIN_IP;
const host = process.env.BLOG_ORIGIN_HOST;
const target = new URL('../cloud-functions/blog/blog-origin.generated.js', import.meta.url);

const PLACEHOLDER_MODULE = `// GENERATED FILE — placeholders only: no origin credentials were available at
// build time, so the proxy fails closed with a 502.
export const BLOG_ORIGIN = {
  ip: '',
  host: '',
};
`;

if (ip && host) {
  const module = `export const BLOG_ORIGIN = {\n  ip: ${JSON.stringify(ip)},\n  host: ${JSON.stringify(host)},\n};\n`;
  writeFileSync(target, module);
  console.log('blog-origin.generated.js: injected origin config');
} else {
  writeFileSync(target, PLACEHOLDER_MODULE);
  if (ip !== undefined || host !== undefined) {
    console.error('BLOG_ORIGIN_IP and BLOG_ORIGIN_HOST must both be configured; cleared origin config');
    process.exitCode = 1;
  } else {
    console.log('blog-origin.generated.js: credentials not set, reset to placeholders');
  }
}
