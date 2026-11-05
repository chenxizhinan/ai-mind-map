/**
 * test-case-designer 技能的运行时加载（版本化 + 自动加载的单一事实源）。
 *
 * - 解析顺序：SKILL_DIR 环境变量 → 仓库内 .agents/skills/...（tsx 开发） → 容器内 /app/skill（Docker COPY）
 * - mtime 缓存：平台更新 SKILL.md 后无需重启 bridge，下一次 get_skill 即最新版本
 * - version 取自 frontmatter（缺省 1.0.0）；hash 为内容指纹（sha256 前 8 位），
 *   即使忘记改版本号，内容变化也可被客户端识别
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SkillInfo {
  content: string;
  version: string;
  hash: string;
  updatedAt: string;
}

const SKILL_MAIN = 'SKILL.md';

let cached: { info: SkillInfo; mtimeMs: number } | null = null;

function skillDirs(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const dirs = [
    process.env.SKILL_DIR,
    resolve(here, '../../../.agents/skills/test-case-designer'), // 仓库内源码（packages/mcp-server/src）
    resolve(here, '../../.agents/skills/test-case-designer'), // 仓库内 dist-server（本地 make bridge）
    resolve(here, 'skill'), // Docker：/app/skill（bridge.mjs 同级）
  ];
  return dirs.filter((d): d is string => !!d);
}

export function getSkill(): SkillInfo {
  for (const dir of skillDirs()) {
    const p = resolve(dir, SKILL_MAIN);
    if (!existsSync(p)) continue;
    const mtimeMs = statSync(p).mtimeMs;
    if (cached && cached.mtimeMs === mtimeMs) return cached.info;
    const content = readFileSync(p, 'utf8');
    const version = /^version:\s*(\S+)/m.exec(content)?.[1] ?? '1.0.0';
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 8);
    const updatedAt = new Date(mtimeMs).toISOString();
    cached = { mtimeMs, info: { content, version, hash, updatedAt } };
    return cached.info;
  }
  return { content: '', version: '0.0.0', hash: '', updatedAt: '' };
}

/** 递归收集技能目录内全部文件（相对路径），用于打包完整技能包 */
export function listSkillFiles(): Array<{ path: string; data: Buffer }> {
  const out: Array<{ path: string; data: Buffer }> = [];
  for (const dir of skillDirs()) {
    if (!existsSync(resolve(dir, SKILL_MAIN))) continue;
    const seen = new Set<string>();
    const walk = (rel: string): void => {
      const abs = resolve(dir, rel);
      let names: string[] = [];
      try {
        names = readdirSync(abs);
      } catch {
        return;
      }
      for (const name of names) {
        const r = rel && rel !== '.' ? `${rel}/${name}` : name;
        const ap = resolve(dir, r);
        let st;
        try {
          st = statSync(ap);
        } catch {
          continue;
        }
        if (st.isDirectory()) walk(r);
        else if (st.isFile() && !seen.has(r)) {
          seen.add(r);
          out.push({ path: r, data: readFileSync(ap) });
        }
      }
    };
    walk('.');
    if (out.length) break; // 用第一个存在的技能目录
  }
  return out;
}

/** 读取技能目录内的附加文件（references/ scripts/ 等）；拒绝路径穿越 */
export function readSkillFile(rel: string): { content: string; updatedAt: string } | null {
  if (!rel || rel.includes('..') || rel.startsWith('/') || rel.includes('\\')) return null;
  for (const dir of skillDirs()) {
    const p = resolve(dir, rel);
    if (!p.startsWith(resolve(dir))) continue;
    if (!existsSync(p) || !statSync(p).isFile()) continue;
    return { content: readFileSync(p, 'utf8'), updatedAt: new Date(statSync(p).mtimeMs).toISOString() };
  }
  return null;
}
