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
});
