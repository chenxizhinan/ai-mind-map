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
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DocStore, type NodeTypeRegistry } from '@ai-mind-map/core';
import { collectToolExecutors, runToolLoop, type AnthropicLike } from './tool-loop.js';
import { renderMethodPrompt } from '@ai-mind-map/core';
import { DirDocManager, SingleDocContext, isValidDocId, type DocContext } from './doc-manager.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools } from './tools.js';

/** 单文件模式选项（兼容旧形态） */
export interface BridgeFileOptions {
  store: () => DocStore;
  setStore: (s: DocStore) => void;
  registry: NodeTypeRegistry;
  filePath: string;
  port: number;
  /** 监听地址，默认 127.0.0.1；容器部署时设为 0.0.0.0 */
  host?: string;
  model?: string;
  anthropicFactory?: () => AnthropicLike;
}

/** 多文档模式选项 */
export interface BridgeDirOptions {
  docs: DirDocManager;
  registry: NodeTypeRegistry;
  port: number;
  /** 监听地址，默认 127.0.0.1；容器部署时设为 0.0.0.0 */
  host?: string;
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

  /** 根路径自描述页：浏览器直接访问 bridge 端口时给出服务说明与端点指引 */
  const rootPageHtml = (): string => {
    let docCount = 1;
    try {
      docCount = isDir ? docs.listDocs().length : 1;
    } catch {
      /* 保持默认 */
    }
    return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>ai-mind-map bridge</title>
<style>
  body { font-family: -apple-system, "PingFang SC", sans-serif; background: #f6f7fb; color: #1e293b;
         display: flex; align-items: center; justify-content: center; min-height: 90vh; margin: 0; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 26px 30px;
          box-shadow: 0 12px 40px rgba(15,23,42,.12); max-width: 520px; }
  h1 { font-size: 17px; margin: 0 0 8px; }
  p { font-size: 13px; color: #475569; line-height: 1.7; margin: 6px 0; }
  code { background: #f1f5f9; border-radius: 5px; padding: 1px 6px; font-size: 12px; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .ok { color: #16a34a; font-weight: 600; }
</style></head>
<body><div class="card">
  <h1>✅ ai-mind-map bridge 服务运行中</h1>
  <p>模式：<code>${isDir ? '多文档（--dir）' : '单文件（--file）'}</code> · 已管理文档：<b>${docCount}</b> 篇</p>
  <p>这是数据同步服务（REST + SSE），<b>没有管理界面</b>。测试用例脑图应用通常部署在同机的
     <code>:47213</code> 端口（如 <code>http://&lt;本机IP&gt;:47213</code>），请以实际部署地址为准。</p>
  <p>主要端点：<code>GET /docs</code> · <code>POST /docs</code> ·
     <code>GET|PUT|DELETE /doc/:id</code> · <code>GET /events</code>(SSE) ·
     <code>POST /ai/chat</code> · <code>GET /connect</code> · <code>POST /mcp</code>(MCP over HTTP)</p>
</div></body></html>`;
  };

  /**
   * MCP Streamable HTTP（/mcp）：让远程 Agent（Claude Code / Codex / 任意 MCP 客户端）
   * 无需本地安装仓库，直接把 `http://<bridge>/mcp` 作为 MCP server URL 导入即可使用。
   *
   * 采用无状态模式：每个请求一个 transport + McpServer 实例（请求结束即释放），
   * 工具面与 stdio MCP server 完全一致（都来自 registerTools），操作作用于当前激活文档。
   */
  const handleMcpHttp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const mcpServer = new McpServer({ name: 'ai-mind-map', version: '0.2.0' });
      registerTools(mcpServer, isDir ? { docs } : { store: singleStore!, filePath: singleFilePath! });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // 无状态：无会话校验，天然支持多客户端/重连
        enableJsonResponse: true,
      });
      res.on('close', () => {
        void transport.close();
        mcpServer.close();
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      console.error('[bridge] /mcp error:', e instanceof Error ? e.message : e);
      if (!res.headersSent) {
        json(res, 500, { error: e instanceof Error ? e.message : String(e) });
      } else {
        res.end();
      }
    }
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
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, If-Match');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    // ---- 根路径：自描述页（浏览器直接访问 bridge 端口时给出指引） ----
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(rootPageHtml());
      return;
    }

    // ---- MCP Streamable HTTP（/mcp）：远程 Agent 无需本地安装，直接 import 该 URL ----
    if (url.pathname === '/mcp') {
      await handleMcpHttp(req, res);
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
      // ---- 连接信息（Agent 接入配置：MCP / Skill / 说明，供应用页面渲染与下载） ----
      if (req.method === 'GET' && url.pathname === '/connect') {
        // 仓库根：从本文件位置上溯（packages/mcp-server/src/ → 上 3 级），
        // 比 process.cwd() 稳（bridge 可能从任意 cwd 启动）
        const here = fileURLToPath(import.meta.url); // .../packages/mcp-server/src/bridge.ts
        const repoRoot = resolve(here, '../../../..');
        const serverEntry = join(repoRoot, 'packages/mcp-server/src/cli.ts');
        const mode = isDir ? 'dir' : 'file';
        const target = isDir ? opts.docs.dir : singleFilePath ?? '';
        // bridge 对外地址：以请求 Host 为准（支持远程部署/自定义端口/反向代理）
        const hostHeader = req.headers.host ?? `localhost:${opts.port}`;
        const bridgeUrl = `http://${hostHeader}`;
        const mcpUrl = `${bridgeUrl}/mcp`;
        json(res, 200, {
          bridgeUrl,
          mode,
          target,
          /** MCP Streamable HTTP 端点：远程 Agent 直接 import 该 URL 即可使用 */
          mcpUrl,
          /** 推荐配置：远程 HTTP MCP（Claude Code / Codex / Cursor 等，复制即用） */
          mcpHttpJson: {
            mcpServers: {
              'ai-mind-map': { type: 'http', url: mcpUrl },
            },
          },
          /** 本地 stdio 配置（Agent 与 bridge 同机时可用） */
          mcpJson: {
            mcpServers: {
              'ai-mind-map': {
                command: 'npx',
                args: ['-y', 'tsx', serverEntry, mode === 'dir' ? '--dir' : '--file', target],
              },
            },
          },
        });
        return;
      }

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
        let id: string | undefined;
        try {
          const body = JSON.parse(raw) as { title?: unknown; id?: unknown };
          title = String(body.title ?? '').trim();
          id = typeof body.id === 'string' && body.id ? body.id : undefined;
        } catch {
          json(res, 400, { error: 'body must be JSON {title}' });
          return;
        }
        if (!title) {
          json(res, 400, { error: 'title required' });
          return;
        }
        await enqueue(async () => {
          const r = opts.docs.createDoc({ title, id });
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
        const ifMatchLegacy = req.headers['if-match'];
        await enqueue(async () => {
          const cur = docs.store();
          const curVersion = cur.document.meta.updatedAt;
          if (typeof ifMatchLegacy === 'string' && ifMatchLegacy.length && curVersion && ifMatchLegacy !== curVersion) {
            json(res, 409, { error: '文档已被其他客户端修改', currentUpdatedAt: curVersion });
            return;
          }
          const d = JSON.parse(raw);
          docs.putDoc('default', d);
          lastMtime = statSync(singleFilePath!).mtimeMs;
          broadcast('default', docs.store().document.meta.title);
          json(res, 200, { ok: true, id: 'default', updatedAt: docs.store().document.meta.updatedAt });
        });
        return;
      }

      // ---- 按文档 id 读写删（--dir 为主；--file 模式任意 id 落到唯一文件，自愈旧 remoteId） ----
      const docIdMatch = /^\/doc\/([^/]+)$/.exec(url.pathname);
      if (docIdMatch && (req.method === 'GET' || req.method === 'PUT' || req.method === 'DELETE')) {
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
        if (req.method === 'DELETE') {
          if (!isDir) {
            json(res, 400, { error: '单文件模式不支持删除文档。请用 --dir 启动多文档模式' });
            return;
          }
          await enqueue(async () => {
            const removed = docs.deleteDoc(rawId);
            if (removed) broadcast(rawId, '');
            json(res, removed ? 200 : 404, removed ? { ok: true } : { error: `document not found: ${rawId}` });
          });
          return;
        }
        // PUT /doc/:id
        const raw = await readBody(req);
        // If-Match 乐观锁：携带客户端最后看到的 meta.updatedAt（save() 每次落盘都会刷新）。
        // 不匹配 = 文档已被其他浏览器/Agent 写过 → 409，客户端拉取最新并备份自己的修改，
        // 而不是静默整树覆盖。
        const ifMatch = req.headers['if-match'];
        await enqueue(async () => {
          const current = isDir ? docs.byId(rawId) : docs.store();
          if (isDir && !current) {
            // dir 模式下未知 id 一律 404：不再静默自建文件，
            // 否则已删除文档会被离线浏览器的自动保存反复"复活"。
            json(res, 404, { error: `document not found: ${rawId}` });
            return;
          }
          if (typeof ifMatch === 'string' && ifMatch.length && current) {
            const curVersion = current.document.meta.updatedAt;
            if (curVersion && curVersion !== ifMatch) {
              json(res, 409, { error: '文档已被其他客户端修改', currentUpdatedAt: curVersion });
              return;
            }
          }
          const d = JSON.parse(raw);
          docs.putDoc(rawId, d);
          if (!isDir) {
            lastMtime = statSync(singleFilePath!).mtimeMs;
          }
          broadcast(rawId, (isDir ? docs.byId(rawId) : docs.store())?.document.meta.title);
          json(res, 200, {
            ok: true,
            id: rawId,
            updatedAt: (isDir ? docs.byId(rawId) : docs.store())?.document.meta.updatedAt,
          });
        });
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
      const { added, changed, removed } = opts.docs.scanForChanges();
      for (const id of [...added, ...changed]) {
        const s = docs.byId(id);
        broadcast(id, s?.document.meta.title);
      }
      // 外部删除也要广播，应用端会据此把“仅远端”卡片同步清理掉
      for (const id of removed) broadcast(id, '');
    } else if (reloadIfChanged()) {
      broadcast('default', docs.store().document.meta.title);
    }
  }, 1000);

  server.listen(opts.port, opts.host ?? '127.0.0.1');
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
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    // HTTP chunks may split a multi-byte UTF-8 character. Decode only after
    // concatenating the raw bytes; coercing each chunk to string separately
    // inserts U+FFFD and can persist corrupted document text.
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
