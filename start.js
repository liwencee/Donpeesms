/**
 * Supervisor — keeps the app alive.
 *
 * Production runs `node server.js` directly, so if that process ever
 * exits (a crash we haven't anticipated, an OOM kill, etc.) the site
 * stays down until the host notices and restarts it. That produced
 * long, silent outages: a blank 500 page from the proxy with nothing in
 * the app's own logs, because the app wasn't running to log anything.
 *
 * This wrapper runs server.js as a child process and restarts it if it
 * exits unexpectedly, with backoff so a boot-loop can't spin the CPU.
 * No new dependencies — just Node's own child_process.
 *
 * Deliberately NOT the default start script: switching how the app
 * boots on a live host is a change worth making intentionally. To use
 * it, point the host's start command at `node start.js`.
 */
const { spawn } = require('child_process');
const path = require('path');

const SERVER = path.join(__dirname, 'server.js');
const MAX_BACKOFF_MS = 30_000;
const RESET_AFTER_MS = 60_000; // ran this long => treat as healthy, reset backoff

let backoff = 1000;
let shuttingDown = false;

function start() {
  const startedAt = Date.now();
  const child = spawn(process.execPath, [SERVER], {
    stdio: 'inherit',
    env: process.env
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;

    const ranFor = Date.now() - startedAt;
    if (ranFor > RESET_AFTER_MS) backoff = 1000; // was stable; start backoff fresh

    console.error(
      `[supervisor] server.js exited (code=${code} signal=${signal}) after ${Math.round(ranFor / 1000)}s — ` +
      `restarting in ${backoff}ms`
    );

    setTimeout(start, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  });

  child.on('error', (err) => {
    console.error('[supervisor] failed to spawn server.js:', err.message);
  });

  // Forward shutdown signals so the child can close connections cleanly.
  const forward = (sig) => () => {
    shuttingDown = true;
    child.kill(sig);
  };
  process.on('SIGTERM', forward('SIGTERM'));
  process.on('SIGINT', forward('SIGINT'));
}

start();
