import { defineConfig } from 'vite';

// Claude 预览面板通过 PORT 环境变量分配端口；本地 npx vite 不带 PORT 时用默认 5173
const port = Number(process.env.PORT) || 5173;

// bridge 地址在构建期注入（Docker/静态部署时指向对外发布的 bridge 地址）；
// 运行期 localStorage 'ai-mind-map:bridge' 仍可覆盖
const bridgeUrl = process.env.VITE_BRIDGE_URL || 'http://localhost:47214';

export default defineConfig({
  define: {
    __AI_MIND_MAP_BRIDGE_URL__: JSON.stringify(bridgeUrl),
  },
  server: { port, strictPort: true },
});
