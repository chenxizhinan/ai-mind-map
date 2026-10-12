/**
 * 桥接服务：浏览器脑图应用 ↔ AI/外部编辑的实时协作枢纽。
 *
 * 形态：`npx tsx packages/mcp-server/src/bridge-cli.ts --file doc.json --port 47214`
 *
 * 端点：
 * - GET  /doc      全量文档 JSON
 * - PUT  /doc      浏览器侧整树保存（经 registry 校验），落盘 + SSE 广播
 * - GET  /events   SSE 事件流：changed（文档已变更，客户端拉 /doc 刷新）
 * - POST /ai/chat  Claude 工具循环（SSE 流式：text / done / error 事件）
 *
 * 数据一致性（单权威副本 + 串行队列）：
 * - bridge 进程内的 DocStore 是权威副本，所有写入都经它落盘
 * - stdio MCP server（另一进程）写文件 → bridge 轮询 mtime 重载 + 广播
 * - 浏览器 PUT /doc 与 AI 工具循环经串行队列互斥，避免交叉写入
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DocStore, type NodeTypeRegistry } from '@ai-mind-map/core';
import { collectToolExecutors, runToolLoop, type ToolExecutor } from './tool-loop.js';
import { renderMethodPrompt } from '@ai-mind-map/core';

export interface BridgeOptions {
  /** 权威 DocStore 惰性引用 */
  store: () => DocStore;
  /** 替换 bridge 内的权威 DocStore（文件外部变更/浏览器 PUT 后） */
  setStore: (s: DocStore) => void;
  registry: NodeTypeRegistry;
  filePath: string;
  port: number;
  /** Claude 模型，默认 claude-opus-5-5 */
  model?: string;
}

export interface BridgeHandle {
  /** 监听完成（端口 0 时此后才能知道实际端口） */
  ready: Promise<number>;
  close: () => Promise<void>;
  /** 测试用：直接广播 changed */
  broadcast: () => void;
}

export function startBridge(opts: BridgeOptions): BridgeHandle {
  const clients = new Set<ServerResponse>();
  let queue: Promise<unknown> = Promise.resolve();
  let lastMtime = 0;
  try {
    lastMtime = statSync(opts.filePath).mtimeMs;
  } catch {
    /* 文件尚不存在 */
  }

  const broadcast = (): void => {
    const payload = `event: changed\ndata: {}\n\n`;
    for (const res of clients) res.write(payload);
  };

  /** 串行队列：浏览器保存与 AI 循环互斥执行 */
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = queue.then(fn, fn);
    queue = p.catch(() => {});
    return p;
  };

  /** 文件被外部（MCP server / 编辑器）修改时重载权威副本；mtime 未变返回 false */
  const reloadIfChanged = (): boolean => {
    try {
      const m = statSync(opts.filePath).mtimeMs;
      if (m === lastMtime) return false;
      lastMtime = m;
      opts.setStore(DocStore.fromJSON(opts.registry, JSON.parse(readFileSync(opts.filePath, 'utf8'))));
      return true;
    } catch (e) {
      console.error('[bridge] reload failed:', e instanceof Error ? e.message : e);
      return false;
    }
  };

  const json = (res: ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    void handler(req, res);
  });

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://bridge');
    // 本地工具，开放 CORS 便于应用从任意端口 dev server 访问
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    // ---- SSE 事件流 ----
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      res.write(`event: hello\ndata: {}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    try {
      // ---- 全量文档 ----
      if (req.method === 'GET' && url.pathname === '/doc') {
        json(res, 200, opts.store().toJSON());
        return;
      }

      if (req.method === 'PUT' && url.pathname === '/doc') {
        const raw = await readBody(req);
        await enqueue(async () => {
          const d = JSON.parse(raw);
          const s = DocStore.fromJSON(opts.registry, d);
          opts.setStore(s);
          mkdirSync(dirname(filePath()), { recursive: true });
          writeFileSync(filePath(), JSON.stringify(s.toJSON(), null, 2), 'utf8');
          lastMtime = statSync(resolve(opts.filePath)).mtimeMs;
          broadcast();
        });
        json(res, 200, { ok: true });
        return;
      }

      // ---- AI 对话（SSE 流式） ----
      if (req.method === 'POST' && url.pathname === '/ai/chat') {
        const raw = await readBody(req);
        const { message } = JSON.parse(raw) as { message?: string };
        if (!message?.trim()) {
          json(res, 400, { error: 'message required' });
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
        await enqueue(async () => {
          const executors = collectToolExecutors(opts.store, opts.filePath);
          let reloadTimer: ReturnType<typeof setInterval> | null = null;
          try {
            // AI 循环中文件可能被外部改：不重载（权威副本在内存，落盘会覆盖外部改动）。
            // 循环结束后统一重载一次，外部改动会被 AI 落盘覆盖——单写者模型下可接受。
            // 从当前文档的一级节点读测试维度标注 → 生成方法约束注入 system
            const dims = opts
              .store()
              .root.children.map((c) => String((c.props as { method?: string }).method ?? ''))
              .filter(Boolean);
            const result = await runToolLoop(executors, message, {
              model: opts.model,
              systemExtra: renderMethodPrompt(dims),
              onText: (t) => {
                res.write(`event: text\ndata: ${JSON.stringify(t)}\n\n`);
              },
            });
            broadcast();
            res.write(`event: done\ndata: ${JSON.stringify({ toolCalls: result.toolCalls })}\n\n`);
          } finally {
            if (reloadTimer) clearInterval(reloadTimer);
          }
        }).catch((e) => {
          const msg = e instanceof Error ? e.message : String(e);
          if (!res.headersSent) json(res, 500, { error: msg });
          else {
            res.write(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`);
            res.end();
          }
        });
        return;
      }

      json(res, 404, { error: 'not found' });
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: e instanceof Error ? e.message : String(e) });
      else res.end();
    }
  }

  const filePath = (): string => resolve(opts.filePath);

  // ---- mtime 轮询（外部进程改文件 → 重载 + 广播） ----
  const pollTimer = setInterval(() => {
    if (reloadIfChanged()) broadcast();
  }, 1000);

  server.listen(opts.port, '127.0.0.1');
  const ready = new Promise<number>((resolve) => {
    server.once('listening', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : opts.port);
    });
  });

  return {
    ready,
    broadcast,
    close: () =>
      new Promise((resolve) => {
        clearInterval(pollTimer);
        for (const c of clients) c.end();
        clients.clear();
        server.close(() => resolve());
      }),
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

export type { ToolExecutor };
