// 构建 client 插件包（DSH Web GUI 浏览器侧）：
//  - esbuild 打包 src/client/index.ts 为单文件 CJS，external 全部 @deepseek-ai/* 与 react 系
//    （由 shell 的 __ModuleLoader__ 提供）；
//  - 包一层 window.__ModuleLoader__.load({ id, factory }) 信封（与官方 client 插件一致），
//    factory 收到的 require 即 loader 提供的模块解析器，module.exports 供 loader 读取。
// 产物：lib/client.js（Node 侧按 exports["./client"] 哈希后经 /plugins 下发）。
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outFile = join(root, 'lib', 'client.js')

const result = await build({
  entryPoints: [join(root, 'src', 'client', 'index.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2020'],
  external: ['react', 'react-dom/*', 'react/jsx-runtime', '@deepseek-ai/*'],
  write: false,
  minify: false,
  sourcemap: false,
  logLevel: 'info',
})

const code = result.outputFiles[0].text
const wrapped = `window.__ModuleLoader__.load({
\tid: "dsh-autotest",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${code.split('\n').map((line) => '\t' + line).join('\n')}
\t\treturn module.exports;
\t}
});
`

await mkdir(dirname(outFile), { recursive: true })
await writeFile(outFile, wrapped, 'utf8')
console.log('[dsh-autotest:client] built ->', outFile)
