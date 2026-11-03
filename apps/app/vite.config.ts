import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Claude 预览面板通过 PORT 环境变量分配端口；本地 npx vite 不带 PORT 时用默认 5173
const port = Number(process.env.PORT) || 5173;

// 未显式配置时由浏览器按当前 hostname 推导，避免远程部署仍指向 localhost。
const bridgeUrl = process.env.VITE_BRIDGE_URL || '';
const skillPath = fileURLToPath(
  new URL('../../.agents/skills/test-case-designer/SKILL.md', import.meta.url),
);
const skillText = readFileSync(skillPath, 'utf8');

export default defineConfig({
  define: {
    __AI_MIND_MAP_BRIDGE_URL__: JSON.stringify(bridgeUrl),
    __AI_MIND_MAP_SKILL__: JSON.stringify(skillText),
  },
  server: { port, strictPort: true },
});
