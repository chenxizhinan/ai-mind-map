export interface DocEntry {
  id: string;
  title: string;
  updatedAt: number;
  /** bridge 侧文档 id（多文档模式；首次推送/同步时挂上） */
  remoteId?: string;
  /** bridge 报告的节点数（remoteOnly 卡片展示用，无需先拉内容） */
  nodeCount?: number;
  /** 内容尚未拉到本地槽位（bridge 侧新建/吸收的文档） */
  remoteOnly?: boolean;
  /** 首次使用自动创建的演示文档：不自动挂载到 bridge，用户真正编辑后才参与同步 */
  demo?: boolean;
}

export interface BridgeDocInfo {
  id: string;
  title: string;
  updatedAt: string;
  nodeCount: number;
}

export interface ReconciledDocsIndex {
  entries: DocEntry[];
  changed: boolean;
  /** 已被远端删除或合并的本地镜像槽位，调用方应同步清理其缓存。 */
  removedLocalIds: string[];
}

/**
 * 以 bridge 文档清单为权威，同步浏览器中的文档索引。
 *
 * 有 remoteId 的条目只是 bridge 文档的本地镜像；远端被删除后必须一并删除，
 * 否则把 remoteId 清空会把已删除的镜像变成新的本地文档，首页会永久出现副本。
 * 从未关联 bridge（没有 remoteId）的本地草稿不受影响。
 */
export function reconcileDocsIndex(
  sourceEntries: DocEntry[],
  bridgeDocs: BridgeDocInfo[],
): ReconciledDocsIndex {
  const bridgeIds = new Set(bridgeDocs.map((doc) => doc.id));
  const titleCount = new Map<string, number>();
  for (const doc of bridgeDocs) titleCount.set(doc.title, (titleCount.get(doc.title) ?? 0) + 1);

  let changed = false;
  const removedLocalIds: string[] = [];
  let entries = sourceEntries.map((entry) => ({ ...entry }));

  // remoteId 表示本地内容是远端文档的镜像。远端删除后同步删除镜像，不能解绑成新文档。
  entries = entries.filter((entry) => {
    if (!entry.remoteId || bridgeIds.has(entry.remoteId)) return true;
    removedLocalIds.push(entry.id);
    changed = true;
    return false;
  });

  for (const bridgeDoc of bridgeDocs) {
    const existing = entries.find((entry) => entry.remoteId === bridgeDoc.id);
    const local =
      titleCount.get(bridgeDoc.title) === 1 && (!existing || existing.remoteOnly)
        ? entries.find(
            (entry) => !entry.remoteOnly && entry.title === bridgeDoc.title && !entry.remoteId,
          )
        : undefined;
    const updatedAt = Date.parse(bridgeDoc.updatedAt) || Date.now();

    if (local) {
      local.remoteId = bridgeDoc.id;
      local.remoteOnly = false;
      local.updatedAt = updatedAt;
      local.nodeCount = bridgeDoc.nodeCount;
      changed = true;
      continue;
    }

    if (existing) {
      if (existing.title !== bridgeDoc.title) {
        existing.title = bridgeDoc.title;
        changed = true;
      }
      if (Math.abs(existing.updatedAt - updatedAt) > 1500) {
        existing.updatedAt = updatedAt;
        changed = true;
      }
      if (existing.nodeCount !== bridgeDoc.nodeCount) {
        existing.nodeCount = bridgeDoc.nodeCount;
        changed = true;
      }
      continue;
    }

    entries.unshift({
      id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      remoteId: bridgeDoc.id,
      title: bridgeDoc.title,
      updatedAt,
      nodeCount: bridgeDoc.nodeCount,
      remoteOnly: true,
    });
    changed = true;
  }

  // 同一 remoteId 只保留一张卡片，优先保留已经有本地内容的条目。
  const merged: DocEntry[] = [];
  const byRemote = new Map<string, DocEntry>();
  for (const entry of entries) {
    if (!entry.remoteId) {
      merged.push(entry);
      continue;
    }
    const previous = byRemote.get(entry.remoteId);
    if (!previous) {
      byRemote.set(entry.remoteId, entry);
      merged.push(entry);
      continue;
    }
    const keep =
      previous.remoteOnly !== entry.remoteOnly
        ? previous.remoteOnly
          ? entry
          : previous
        : entry.updatedAt > previous.updatedAt
          ? entry
          : previous;
    const remove = keep === previous ? entry : previous;
    removedLocalIds.push(remove.id);
    if (keep !== previous) merged[merged.indexOf(previous)] = keep;
    byRemote.set(entry.remoteId, keep);
    changed = true;
  }

  return { entries: merged, changed, removedLocalIds };
}
