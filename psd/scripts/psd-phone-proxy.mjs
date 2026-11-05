#!/usr/bin/env node
// psd-phone-proxy.mjs — the phone's front door.
//
// Why this exists: PSD refuses browser-origin requests it did not originate, so
// a random site cannot drive the agent (see authorised() in src/server.js). A
// phone browser is a browser, so it needs a trusted hop that holds the token.
//
// This proxy is that hop, and it runs on the PC — never on the phone:
//   * serves the app from loopback with `data-proxied="1"` (no token in the UI)
//   * forwards /psd/* and /v1/* to PSD with the token and full streaming
//   * options: --insecure-http (self-signed TLS proxy), --bind, --port
//
//   node scripts/psd-phone-proxy.mjs --port 7789
//   tailscale serve --bg 7789        # then it works from anywhere, privately

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] ?? true : fallback;
};

const config = loadConfig();
const listenPort = Number(flag('port', 7789));
const bind = String(flag('bind', '0.0.0.0'));
const upstreamHost = '127.0.0.1';
const upstreamPort = config.port;
const insecure = flag('insecure-http', null);
const certFile = flag('cert', null);
const keyFile = flag('key', null);

const WEB = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'web');
const STATIC = {
  '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js',
  '/styles.css': 'styles.css', '/sw.js': 'sw.js', '/manifest.webmanifest': 'manifest.webmanifest',
  '/icon.svg': 'icon.svg',
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png',
};

function forward(req, res) {
  const headers = { ...req.headers, host: `${upstreamHost}:${upstreamPort}` };
  // The token lives here, not on the phone. This is the whole point of the proxy.
  headers['x-psd-token'] = config.token;
  headers.authorization = `Bearer ${config.token}`;
  // The phone's browser Origin is dropped, deliberately: this proxy IS the trust
  // boundary. It runs on the PC, it started with the owner's session, and it
  // holds the token — so upstream sees a plain loopback client, and PSD's
  // "no foreign browser origin" rule stays intact with no configuration.
  delete headers.origin;
  delete headers.referer;
  delete headers['x-forwarded-for'];

  const upstream = http.request({
    host: upstreamHost, port: upstreamPort, method: req.method, path: req.url, headers,
  }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(res);            // streams SSE straight through, unbuffered
  });
  upstream.on('error', (err) => {
    if (res.headersSent) return res.end();
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'upstream_down', detail: `PSD is not answering on ${upstreamHost}:${upstreamPort} — ${err.message}` }));
  });
  req.pipe(upstream);
}

function serveShell(req, res, name) {
  try {
    let body = fs.readFileSync(path.join(WEB, name));
    if (name === 'index.html') {
      body = Buffer.from(body.toString('utf8')
        .replace('<html lang="en" data-theme="dark">', '<html lang="en" data-theme="dark" data-proxied="1">'));
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(name)] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'web_shell_missing' }));
  }
}

const handler = (req, res) => {
  const pathname = (req.url ?? '/').split('?')[0];
  if (STATIC[pathname]) return serveShell(req, res, STATIC[pathname]);
  if (pathname.startsWith('/psd/') || pathname.startsWith('/v1/') || pathname === '/health') return forward(req, res);
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found', detail: 'The proxy serves the app, /psd/* and /v1/* only.' }));
};

const server = (insecure && certFile && keyFile)
  ? https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, handler)
  : http.createServer(handler);

server.listen(listenPort, bind, () => {
  const scheme = (insecure && certFile) ? 'https' : 'http';
  const addresses = [`${scheme}://127.0.0.1:${listenPort}`];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (name === 'lo') continue;
    for (const addr of addrs ?? []) if (addr.family === 'IPv4' && !addr.internal) addresses.push(`${scheme}://${addr.address}:${listenPort}`);
  }
  console.log('');
  console.log('  ◆ PSD phone proxy — the token stays on this PC');
  console.log(`   PSD upstream : http://${upstreamHost}:${upstreamPort}`);
  console.log(`   Phone app    : ${addresses.join('  ')}`);
  console.log('   From anywhere: tailscale serve --bg ' + listenPort);
  console.log('');
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
