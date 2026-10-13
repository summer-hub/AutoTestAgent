// 构建 agent 接口层双件套：esbuild 打两个**单文件**产物（Node ≥20 直接运行，零依赖安装）。
//   dist/cli.mjs        — CLI（octo-cli 模式：JSON envelope + 确定性退出码 + 零交互）
//   dist/mcp-server.mjs — MCP stdio server（initialize / tools/list / tools/call）
// 两个入口共享 core/ 与 commands/——命令规格的单一事实源在此落地为双端。
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'dist'), { recursive: true });

const common = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node20'],
  sourcemap: false,
  logLevel: 'info',
  // shebang：CLI 可直接 ./dist/cli.mjs 执行（Linux/macOS 需 +x；Windows 用 node 跑）
  banner: { js: '#!/usr/bin/env node' },
};

await build({ ...common, entryPoints: [join(root, 'src/cli.ts')], outfile: join(root, 'dist/cli.mjs') });
await build({ ...common, entryPoints: [join(root, 'src/mcp.ts')], outfile: join(root, 'dist/mcp-server.mjs') });
// specs.mjs：纯模块产物（无 shebang），供自检脚本与外部工具消费命令规格
await build({
  ...common,
  banner: undefined,
  entryPoints: [join(root, 'src/specs.ts')],
  outfile: join(root, 'dist/specs.mjs'),
});
console.log('[agent-tools] built -> dist/cli.mjs + dist/mcp-server.mjs + dist/specs.mjs');
