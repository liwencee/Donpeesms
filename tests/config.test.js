/**
 * Config integrity tests — guard against the mistakes that actually
 * caused outages in this project, so they can never silently recur.
 */
process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

describe('secrets are not committed', () => {
  // A real incident: live JWT secrets were committed to this PUBLIC repo
  // inside RAILWAY_SETUP.md. Anything tracked must use placeholders.
  const trackedDocs = ['README.md', '.env.example'];

  test.each(trackedDocs)('%s contains no real-looking secret values', (file) => {
    let content;
    try { content = read(file); } catch { return; } // file may not exist

    // A 64+ char hex string is what our generated JWT/encryption keys
    // look like — placeholders never match this.
    const longHex = /\b[a-f0-9]{64,}\b/i;
    expect(content).not.toMatch(longHex);

    // A postgres URL with a password that isn't an obvious placeholder.
    const realDbUrl = /postgres(?:ql)?:\/\/[^\s:]+:(?!<|\[|your|password|YOUR)[^\s@]{8,}@/;
    expect(content).not.toMatch(realDbUrl);
  });

  test('.gitignore excludes env files', () => {
    const gi = read('.gitignore');
    expect(gi).toMatch(/^\.env$/m);
    expect(gi).toMatch(/\.env\.production/);
  });
});

describe('package.json integrity', () => {
  const pkg = require('../package.json');

  test('start script points at a file that exists', () => {
    const m = pkg.scripts.start.match(/node\s+(\S+)/);
    expect(m).not.toBeNull();
    expect(fs.existsSync(path.join(root, m[1]))).toBe(true);
  });

  test('every dependency the code requires is declared', () => {
    // Catches "works locally, crashes on the host after a fresh install"
    // — the class of failure that takes the whole site down on deploy.
    const declared = new Set([
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.devDependencies || {}),
      ...require('module').builtinModules
    ]);

    const dirs = ['controllers', 'routes', 'middleware', 'services', 'utils', 'config', 'webhooks'];
    const files = ['server.js', 'start.js'];
    for (const d of dirs) {
      const dir = path.join(root, d);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.js')) files.push(path.join(d, f));
      }
    }

    const missing = new Set();
    for (const file of files) {
      const src = read(file);
      const re = /require\(['"]([^'".][^'"]*)['"]\)/g; // skip relative paths
      let m;
      while ((m = re.exec(src)) !== null) {
        const base = m[1].startsWith('@')
          ? m[1].split('/').slice(0, 2).join('/')
          : m[1].split('/')[0];
        if (!declared.has(base)) missing.add(`${base} (in ${file})`);
      }
    }
    expect(Array.from(missing)).toEqual([]);
  });
});

describe('server resilience guarantees', () => {
  const src = read('server.js');

  test('uncaughtException does NOT shut the process down', () => {
    // Regression guard for the root cause of the recurring outages:
    // a single uncaught error used to call shutdown() and take the
    // entire site offline for every user.
    const handler = src.match(/process\.on\(\s*['"]uncaughtException['"][\s\S]{0,400}?\n\s*\}\);/);
    expect(handler).not.toBeNull();
    expect(handler[0]).not.toMatch(/shutdown\(/);
    expect(handler[0]).not.toMatch(/process\.exit/);
  });

  test('unhandledRejection does NOT shut the process down', () => {
    const handler = src.match(/process\.on\(\s*['"]unhandledRejection['"][\s\S]{0,400}?\n\s*\}\);/);
    expect(handler).not.toBeNull();
    expect(handler[0]).not.toMatch(/shutdown\(/);
    expect(handler[0]).not.toMatch(/process\.exit/);
  });

  test('config/env.js never calls process.exit on a missing var', () => {
    // Another real outage: a missing JWT var killed the process at boot,
    // taking the frontend down with it.
    // Strip comments first — the file legitimately *mentions*
    // process.exit in a comment explaining why it must never be used.
    const env = read('config/env.js')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(env).not.toMatch(/process\.exit/);
  });
});
