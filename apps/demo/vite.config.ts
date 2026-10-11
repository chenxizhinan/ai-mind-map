import { defineConfig } from 'vite';

// Claude 预览面板通过 PORT 环境变量分配端口；本地 npx vite 不带 PORT 时用默认 5173
const port = Number(process.env.PORT) || 5173;

export default defineConfig({
  server: { port, strictPort: true },
});
