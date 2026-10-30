#!/usr/bin/env node
/**
 * 生产环境静态文件服务（零依赖，node:http）。
 *
 * - 服务 apps/app/dist 构建产物（SPA：未命中的路径回退 index.html）
 * - 带内容哈希的 /assets 走长缓存；index.html 不缓存
 *
 * 环境变量：
 *   PORT  监听端口（默认 8080）
 *   HOST  监听地址（默认 0.0.0.0，容器内需要）
 *   WEB_ROOT 静态文件目录（默认 ./web）
 */
import { createServer } from 'node:http';
import { statSync, readFileSync, existsSync } from 'node:fs';
import { join, normalize, extname, resolve } from 'node:path';

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = resolve(process.env.WEB_ROOT || './web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function serveFile(res, filePath) {
  const ext = extname(filePath).toLowerCase();
  const type = MIME[ext] ?? 'application/octet-stream';
  const cacheControl = ext === '.html'
    ? 'no-cache'
    : filePath.includes('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';
  const body = readFileSync(filePath);
  send(res, 200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': cacheControl }, body);
}

const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, { Allow: 'GET, HEAD' }, '');
    return;
  }
  try {
    const urlPath = decodeURIComponent(new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname);
    let filePath = resolve(join(ROOT, normalize(urlPath).replace(/^([/\\])+/, '')));
    if (!filePath.startsWith(ROOT)) {
      send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Forbidden');
      return;
    }
    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      filePath = join(filePath, 'index.html');
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      // SPA 回退
      filePath = join(ROOT, 'index.html');
    }
    serveFile(res, filePath);
  } catch (e) {
    send(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, `Internal error: ${e instanceof Error ? e.message : String(e)}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[ai-mind-map web] http://${HOST}:${PORT}  (root: ${ROOT})`);
});
