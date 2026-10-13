/**
 * 桥接服务：浏览器脑图应用 ↔ AI/外部编辑的实时协作枢纽。
 *
 * 形态：
 * - 单文档（兼容）：`npx tsx packages/mcp-server/src/bridge-cli.ts --file doc.json --port 47214`
 * - 多文档：`npx tsx packages/mcp-server/src/bridge-cli.ts --dir ./mindmaps --port 47214`
 *
 * 端点：
 * - GET  /docs        文档列表 [{id,title,updatedAt,nodeCount,active}]（两种模式都支持）
 * - POST /docs        新建文档 {title} → {id,title,rootId}（仅 --dir 模式）
 * - GET  /doc/:id     全量文档 JSON（--file 模式任意 id 都返回唯一文档，自愈旧 remoteId）
 * - PUT  /doc/:id     浏览器侧整树保存（经 registry 校验），落盘 + SSE 广播
 * - GET  /doc         兼容端点（--file 模式等价 /doc/default）
 * - GET  /events      SSE 事件流：changed（data 携带 {docId,title,updatedAt}）
 * - POST /ai/chat     Claude 工具循环（SSE 流式：text / done / error 事件），body 可带 docId 定向
 *
 * 数据一致性（单权威副本 + 串行队列）：
 * - bridge 进程内的 DocStore 是权威副本，所有写入都经它落盘
 * - stdio MCP server（另一进程）写文件 → bridge 轮询 mtime 重载 + 广播
 * - 浏览器 PUT 与 AI 工具循环经串行队列互斥，避免交叉写入
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DocStore, type NodeTypeRegistry } from '@ai-mind-map/core';
import { collectToolExecutors, runToolLoop, type AnthropicLike } from './tool-loop.js';
import { renderMethodPrompt } from '@ai-mind-map/core';
import { DirDocManager, SingleDocContext, isValidDocId, type DocContext } from './doc-manager.js';

/** 单文件模式选项（兼容旧形态） */
export interface BridgeFileOptions {
  store: () => DocStore;
  setStore: (s: DocStore) => void;
  registry: NodeTypeRegistry;
  filePath: string;
  port: number;
  model?: string;
  anthropicFactory?: () => AnthropicLike;
}

/** 多文档模式选项 */
export interface BridgeDirOptions {
  docs: DirDocManager;
  registry: NodeTypeRegistry;
  port: number;
  model?: string;
  anthropicFactory?: () => AnthropicLike;
}

export type BridgeOptions = BridgeFileOptions | BridgeDirOptions;

export interface BridgeHandle {
  /** 监听完成（端口 0 时此后才能知道实际端口） */
  ready: Promise<number>;
  close: () => Promise<void>;
  /** 测试用：直接广播 changed */
  broadcast: (docId?: string, title?: string) => void;
}

export function startBridge(opts: BridgeOptions): BridgeHandle {
  const clients = new Set<ServerResponse>();
  let queue: Promise<unknown> = Promise.resolve();

  const isDir = 'docs' in opts;
  const registry = opts.registry;
  /** 统一文档上下文（两种模式） */
  let docs: DocContext;
  /** 单文件模式的可变 store 引用与文件路径 */
  let singleStore: (() => DocStore) | null = null;
  let singleSetStore: ((s: DocStore) => void) | null = null;
  let singleFilePath: string | null = null;
  let lastMtime = 0;

  if (isDir) {
    docs = opts.docs;
  } else {
    singleStore = opts.store;
    singleSetStore = opts.setStore;
    singleFilePath = resolve(opts.filePath);
    docs = new SingleDocContext(registry, singleFilePath, opts.store, opts.setStore);
    try {
      lastMtime = statSync(singleFilePath).mtimeMs;
    } catch {
      /* 文件尚不存在 */
    }
  }

  const broadcast = (docId?: string, title?: string): void => {
    const data = docId
      ? JSON.stringify({ docId, title: title ?? '', updatedAt: new Date().toISOString() })
      : '{}';
    const payload = `event: changed\ndata: ${data}\n\n`;
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
    if (isDir) return false; // dir 模式走 scanForChanges
    try {
      const m = statSync(singleFilePath!).mtimeMs;
      if (m === lastMtime) return false;
      lastMtime = m;
      singleSetStore!(DocStore.fromJSON(registry, JSON.parse(readFileSync(singleFilePath!, 'utf8'))));
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
      // ---- 文档列表（两种模式） ----
      if (req.method === 'GET' && url.pathname === '/docs') {
        json(res, 200, { docs: docs.listDocs() });
        return;
      }

      // ---- 新建文档（仅 --dir） ----
      if (req.method === 'POST' && url.pathname === '/docs') {
        if (!isDir) {
          json(res, 400, { error: '单文件模式不支持新建文档。请用 --dir 启动多文档模式' });
          return;
        }
        const raw = await readBody(req);
        let title = '';
        try {
          title = String((JSON.parse(raw) as { title?: unknown }).title ?? '').trim();
        } catch {
          json(res, 400, { error: 'body must be JSON {title}' });
          return;
        }
        if (!title) {
          json(res, 400, { error: 'title required' });
          return;
        }
        await enqueue(async () => {
          const r = opts.docs.createDoc({ title });
          json(res, 200, r);
        });
        return;
      }

      // ---- 全量文档 ----
      // 兼容端点：--file 模式 GET/PUT /doc 等价 /doc/default；--dir 模式 404 引导
      if (req.method === 'GET' && url.pathname === '/doc') {
        if (isDir) {
          json(res, 404, { error: 'multi-doc bridge: use /docs and /doc/:id' });
          return;
        }
        json(res, 200, docs.store().toJSON());
        return;
      }

      if (req.method === 'PUT' && url.pathname === '/doc') {
        if (isDir) {
          json(res, 404, { error: 'multi-doc bridge: use /docs and /doc/:id' });
          return;
        }
        const raw = await readBody(req);
        await enqueue(async () => {
          const d = JSON.parse(raw);
          docs.putDoc('default', d);
          lastMtime = statSync(singleFilePath!).mtimeMs;
          broadcast('default', docs.store().document.meta.title);
        });
        json(res, 200, { ok: true });
        return;
      }

      // ---- 按文档 id 读写（--dir 为主；--file 模式任意 id 落到唯一文件，自愈旧 remoteId） ----
      const docIdMatch = /^\/doc\/([^/]+)$/.exec(url.pathname);
      if (docIdMatch && (req.method === 'GET' || req.method === 'PUT')) {
        const rawId = decodeURIComponent(docIdMatch[1]!);
        if (!isValidDocId(rawId)) {
          json(res, 400, { error: `invalid doc id` });
          return;
        }
        if (req.method === 'GET') {
          const s = isDir ? docs.byId(rawId) : docs.store();
          if (!s) {
            json(res, 404, { error: `document not found: ${rawId}` });
            return;
          }
          json(res, 200, s.toJSON());
          return;
        }
        // PUT /doc/:id
        const raw = await readBody(req);
        await enqueue(async () => {
          const d = JSON.parse(raw);
          docs.putDoc(rawId, d);
          if (!isDir) {
            lastMtime = statSync(singleFilePath!).mtimeMs;
          }
          broadcast(rawId, (isDir ? docs.byId(rawId) : docs.store())?.document.meta.title);
        });
        json(res, 200, { ok: true });
        return;
      }

      // ---- AI 对话（SSE 流式） ----
      if (req.method === 'POST' && url.pathname === '/ai/chat') {
        const raw = await readBody(req);
        const { message, docId } = JSON.parse(raw) as { message?: string; docId?: string };
        if (!message?.trim()) {
          json(res, 400, { error: 'message required' });
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
        await enqueue(async () => {
          // 预设激活文档（本次会话的节点工具作用于它）
          if (docId && isDir) {
            try {
              opts.docs.openDoc({ id: docId });
            } catch {
              /* docId 无法解析时用当前激活文档 */
            }
          }
          const executors = collectToolExecutors(docs);
          try {
            // 从当前文档的一级节点读测试维度标注 → 生成方法约束注入 system
            const dims = docs
              .store()
              .root.children.map((c) => String((c.props as { method?: string }).method ?? ''))
              .filter(Boolean);
            const result = await runToolLoop(executors, message, {
              model: opts.model,
              systemExtra: renderMethodPrompt(dims),
              clientFactory: opts.anthropicFactory,
            });
            // AI 循环可能 create_document/open_document 切换过文档：对脏文档逐一广播
            if (isDir) {
              for (const id of opts.docs.takeDirty()) {
                const s = opts.docs.byId(id);
                broadcast(id, s?.document.meta.title);
              }
            } else {
              broadcast('default', docs.store().document.meta.title);
            }
            res.write(`event: done\ndata: ${JSON.stringify({ toolCalls: result.toolCalls })}\n\n`);
            res.end(); // 请求收尾：客户端读到 done 后连接自然关闭
          } finally {
            /* noop */
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

  // ---- 轮询（外部进程改文件 → 重载 + 广播） ----
  const pollTimer = setInterval(() => {
    if (isDir) {
      const { added, changed } = opts.docs.scanForChanges();
      for (const id of [...added, ...changed]) {
        const s = docs.byId(id);
        broadcast(id, s?.document.meta.title);
      }
    } else if (reloadIfChanged()) {
      broadcast('default', docs.store().document.meta.title);
    }
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
