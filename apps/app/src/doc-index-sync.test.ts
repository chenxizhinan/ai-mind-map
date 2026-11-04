import { describe, expect, it } from 'vitest';
import { reconcileDocsIndex, type BridgeDocInfo, type DocEntry } from './doc-index-sync.js';

const remote: BridgeDocInfo = {
  id: 'BYOS-current',
  title: 'BYOS 验证与测试用例',
  updatedAt: '2026-10-27T10:25:59.757Z',
  nodeCount: 168,
};

describe('reconcileDocsIndex', () => {
  it('removes a stale local mirror when the same titled authoritative remote document survives', () => {
    const entries: DocEntry[] = [
      {
        id: 'local-current',
        remoteId: remote.id,
        title: remote.title,
        updatedAt: Date.parse(remote.updatedAt),
        nodeCount: remote.nodeCount,
        remoteOnly: false,
      },
      {
        id: 'local-stale',
        remoteId: 'BYOS-deleted-copy',
        title: remote.title,
        updatedAt: Date.parse(remote.updatedAt) - 60_000,
        nodeCount: 220,
        remoteOnly: false,
      },
    ];

    const result = reconcileDocsIndex(entries, [remote]);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.remoteId).toBe(remote.id);
    expect(result.removedLocalIds).toEqual(['local-stale']);
  });

  it('keeps an intentionally local-only document even when its title matches a remote document', () => {
    const entries: DocEntry[] = [
      {
        id: 'local-current',
        remoteId: remote.id,
        title: remote.title,
        updatedAt: Date.parse(remote.updatedAt),
        nodeCount: remote.nodeCount,
        remoteOnly: false,
      },
      {
        id: 'local-draft',
        title: remote.title,
        updatedAt: Date.parse(remote.updatedAt) + 60_000,
        remoteOnly: false,
      },
    ];

    const result = reconcileDocsIndex(entries, [remote]);

    expect(result.entries).toHaveLength(2);
    expect(result.removedLocalIds).toEqual([]);
  });

  it('never binds a first-run demo draft to a same-titled remote document', () => {
    // 场景：每个新浏览器都会本地生成演示文档「订单中心 · 回归测试」（demo 标记），
    // 而 bridge 上可能残留历史污染的同名文档。演示草稿绝不能被按标题吸收绑定，
    // 否则用户在演示卡片里的操作会作用到远端真实文档上。
    const demoPolluted: BridgeDocInfo = {
      id: 'Hades-Chat-App-测试用例',
      title: '订单中心 · 回归测试',
      updatedAt: '2026-11-04T03:05:44.938Z',
      nodeCount: 12136,
    };
    const entries: DocEntry[] = [
      {
        id: 'demo-draft',
        title: '订单中心 · 回归测试',
        updatedAt: Date.now(),
        remoteOnly: false,
        demo: true,
      },
    ];

    const result = reconcileDocsIndex(entries, [demoPolluted]);

    // 演示草稿保持独立（不挂 remoteId）；远端文档以 remoteOnly 卡片形式并列出现
    const demo = result.entries.find((e) => e.id === 'demo-draft');
    const mirror = result.entries.find((e) => e.remoteId === demoPolluted.id);
    expect(demo?.remoteId).toBeUndefined();
    expect(demo?.demo).toBe(true);
    expect(mirror?.remoteOnly).toBe(true);
    expect(result.entries).toHaveLength(2);
    expect(result.removedLocalIds).toEqual([]);
  });
});
