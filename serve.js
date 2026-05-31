/**
 * DonPeeSMS — Local Dev Server (no MongoDB required)
 * Serves the /public folder as a SPA on http://localhost:3000
 * Run with:  node serve.js
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT   = 3000;
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html' : 'text/html; charset=utf-8',
  '.css'  : 'text/css',
  '.js'   : 'application/javascript',
  '.json' : 'application/json',
  '.xml'  : 'application/xml',
  '.txt'  : 'text/plain',
  '.png'  : 'image/png',
  '.jpg'  : 'image/jpeg',
  '.jpeg' : 'image/jpeg',
  '.svg'  : 'image/svg+xml',
  '.ico'  : 'image/x-icon',
  '.webp' : 'image/webp',
  '.woff2': 'font/woff2',
  '.woff' : 'font/woff',
  '.ttf'  : 'font/ttf',
};

const COLORS = {
  reset : '\x1b[0m',
  green : '\x1b[32m',
  cyan  : '\x1b[36m',
  yellow: '\x1b[33m',
  grey  : '\x1b[90m',
};

function log(method, url, status) {
  const color = status < 300 ? COLORS.green : status < 400 ? COLORS.cyan : COLORS.yellow;
  const time  = new Date().toLocaleTimeString();
  console.log(`${COLORS.grey}${time}${COLORS.reset}  ${color}${status}${COLORS.reset}  ${method.padEnd(6)} ${url}`);
}

const server = http.createServer((req, res) => {
  // Strip query strings for file lookup
  const urlPath  = req.url.split('?')[0];
  let   filePath = path.join(PUBLIC, urlPath === '/' ? 'index.html' : urlPath);
  const ext      = path.extname(filePath).toLowerCase();

  // Security: prevent path traversal
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end('Forbidden');
    log(req.method, req.url, 403);
    return;
  }

  const serveFile = (fp, statusCode) => {
    fs.readFile(fp, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
        log(req.method, req.url, 404);
        return;
      }
      const mime = MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream';
      res.writeHead(statusCode, {
        'Content-Type' : mime,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      });
      res.end(data);
      log(req.method, req.url, statusCode);
    });
  };

  // Try the exact file first
  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isFile()) {
      serveFile(filePath, 200);
    } else if (!err && stat.isDirectory()) {
      // Try index.html inside directory
      serveFile(path.join(filePath, 'index.html'), 200);
    } else {
      // SPA fallback — any unknown route gets index.html
      serveFile(path.join(PUBLIC, 'index.html'), 200);
    }
  });
});

server.listen(PORT, () => {
  console.log(`
${COLORS.cyan}╔══════════════════════════════════════════╗
║   DonPeeSMS — Local Dev Server           ║
╠══════════════════════════════════════════╣
║   ${COLORS.green}http://localhost:${PORT}${COLORS.cyan}                  ║
║   Serving: /public                       ║
║   Press Ctrl+C to stop                   ║
╚══════════════════════════════════════════╝${COLORS.reset}
`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌  Port ${PORT} is already in use. Try: node serve.js --port 3001\n`);
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n\n👋  Server stopped.\n');
  process.exit(0);
});
