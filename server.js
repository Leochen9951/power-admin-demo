import http from 'node:http';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { ROOT, get } from './db.js';
import { dispatch } from './api.js';

const PORT = Number(process.env.PORT || 4399);
const HOST = process.env.HOST || '0.0.0.0';   // 容器/PaaS 内需监听所有网卡
const PUBLIC_DIR = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (pathname.startsWith('/api/')) {
    try {
      const body = await readBody(req);
      const out = await dispatch({ req, res, url, pathname, body });
      if (out !== undefined && !res.writableEnded) sendJson(res, out.status || 200, out.body ?? out);
    } catch (err) {
      console.error('[api]', req.method, pathname, err.message);
      if (!res.writableEnded) sendJson(res, err.status || 500, { error: err.message || '服务器错误' });
    }
    return;
  }

  // 静态资源
  let filePath = pathname === '/' ? '/index.html' : pathname;
  if (pathname === '/pay') filePath = '/pay.html';
  if (pathname === '/admin') filePath = '/index.html';
  const abs = path.normalize(path.join(PUBLIC_DIR, filePath));
  if (!abs.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const s = await stat(abs);
    if (s.isDirectory()) throw new Error('dir');
    const buf = await readFile(abs);
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1 style="font-family:system-ui;padding:40px">404 — 页面不存在</h1>');
  }
});

function readBody(req) {
  return new Promise((resolve) => {
    if (req.method === 'GET' || req.method === 'HEAD') return resolve(null);
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(null);
      try { resolve(JSON.parse(raw)); } catch { resolve({ __raw: raw }); }
    });
    req.on('error', () => resolve(null));
  });
}

export function sendJson(res, status, payload) {
  const buf = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

// 首次启动自动生成演示数据
try {
  const { c } = get('SELECT COUNT(*) c FROM accounts');
  if (!c) {
    const t0 = Date.now();
    const { seed } = await import('./lib/seed.js');
    seed({ force: true });
    console.log(`  首次启动：已生成演示数据（${Date.now() - t0}ms）`);
  }
} catch (e) {
  console.error('初始化演示数据失败：', e.message);
}

// 线上演示可选：每天自动把读数补齐到昨天，避免放几天后全部显示离线
if (process.env.DEMO_FRESH === '1') {
  const runFresh = async () => {
    try {
      const { keepFresh } = await import('./lib/mock.js');
      const r = keepFresh();
      if (r.inserted) console.log(`  演示数据保鲜：补齐 ${r.inserted} 条读数至 ${r.until}`);
    } catch (e) {
      console.error('演示数据保鲜失败：', e.message);
    }
  };
  runFresh();
  setInterval(runFresh, 6 * 60 * 60 * 1000);
}

server.listen(PORT, HOST, () => {
  console.log(`\n  电力管理后台  http://localhost:${PORT}  (listen ${HOST}:${PORT})`);
  console.log(`  用户缴费端    http://localhost:${PORT}/pay`);
  console.log(`  健康检查      http://localhost:${PORT}/api/healthz\n`);
});
