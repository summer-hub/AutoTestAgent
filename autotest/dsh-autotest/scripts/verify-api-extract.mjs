// P2 接口面提取的离线自检（无设备、无 LLM、无 DB；用临时目录里的合成工程）。
//
// 为什么要成套：提取结果后面要当"覆盖率的分母"用，分母错一个，所有覆盖结论都错。
// 而且提取本身很容易静默少东西 —— 本文件里最贵的一组检查就是"扫描器不许错位"那一组：
// 开发中被它坑过一次（正则字面量 `/[^+/0-9A-Za-z-_]/g` 里的 `/` 与字符类让朴素扫描器错位，
// 之后整个文件后半段被当成字符串清空，符号数量静默变少且看不出原因）。
//
// 用法：npm run build && npm run verify:api-extract
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  scanSource, maskCommentsAndStrings, parseJson5Like, parseParamList, parseJsdoc, jsdocBefore,
  parseExports, resolveEntryFile, resolveFileLike, resolveRelativeSpec,
  extractDefinition, collectSymbolsFromEntry, readPageRoutes, collectDemoAssets,
  collectCallSites, findDemoModuleDir, extractLibraryApi, renderApiDoc, sourceScope,
} from '../lib/services/apiExtract.js';

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};
const eq = (a, b, label) => check(JSON.stringify(a) === JSON.stringify(b), label, `got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);

// ---------- 1. 扫描器：不许错位（本组是这套自检的核心）----------
console.log('— 扫描器（注释/字符串/模板串/正则 vs 除号）—');
{
  const src = [
    'const s = "export function fake() {}";',
    "const t = 'const x = 1';",
    '// export function inComment() {}',
    '/* export class InBlock() {} */',
    'const re = /[^+/0-9A-Za-z-_]/g;',
    'const re2 = /\\/g;',
    'const q = `template with \'quote\' and export function inTemplate() {}`;',
    'const ratio = a / b / c;',
    'export function realFn(a, b) {}',
  ].join('\n');
  const { codeOnly, commentFree, isCode } = scanSource(src);
  check(codeOnly.length === src.length && commentFree.length === src.length, '掩码与原文字符数一致（等长替换）');
  check(!/fake/.test(codeOnly), '字符串里的 export function 不会被当成代码');
  check(!/inComment|InBlock|inTemplate/.test(codeOnly.replace(/\s/g, '')), '注释/模板串里的内容不会被当成代码');
  check(/realFn/.test(codeOnly), '真代码里的 export function 仍然可见');
  check(/^const re =\s+g;/.test(codeOnly.split('\n')[4]), '正则字面量整体被清空（字符类里的 / 不会让它提前结束）', JSON.stringify(codeOnly.split('\n')[4]));
  check(commentFree.includes('/[^+/0-9A-Za-z-_]/g'), 'commentFree 保留正则原文');
  check(commentFree.includes('"export function fake() {}"'), 'commentFree 保留字符串原文（模块说明符要读它）');
  check(!isCode[commentFree.indexOf('fake')], '字符串内部被标记为非代码');
  // 除以号不能被当成正则起始：`a / b / c` 之后的内容必须仍是代码
  const divIdx = codeOnly.indexOf('realFn');
  check(divIdx > 0 && isCode[divIdx], '除法（a / b / c）不会把后续代码吞进正则');
  check(maskCommentsAndStrings(src).length === src.length, 'maskCommentsAndStrings 仍是等长掩码（兼容旧调用）');
}

// ---------- 2. 清单解析 ----------
console.log('\n— oh-package.json5 解析（注释/尾逗号/单引号/无引号键）—');
{
  const j = parseJson5Like(`{
  // 单行注释
  name: '@ohos/jsonschema',   /* 块注释 */
  main: 'index.ts',
  types: "",
  version: "2.0.2",
  dependencies: { "@ohos/hypium": "1.0.6", },
}`);
  eq(j.name, '@ohos/jsonschema', '无引号键 + 单引号值');
  eq(j.main, 'index.ts', 'main 字段可读');
  eq(j.types, '', '空字符串值不被丢掉（types 为空就要回落到 main）');
  eq(j.version, '2.0.2', '版本可读');
  eq(j.dependencies, { '@ohos/hypium': '1.0.6' }, '尾逗号被容忍');
}

// ---------- 3. JSDoc / 参数表 ----------
console.log('\n— JSDoc 与参数表 —');
{
  const js = parseJsdoc(`/**
   * 校验一个实例是否符合 schema
   * @param {object} instance 待校验对象
   * @param {object} schema schema 定义
   * @param {object} [options] 选项
   * @param {number} [limit=10] 上限
   * @returns {object} 校验结果
   * @throws {SchemaError} schema 非法时抛出
   * @since 2.0.0
   * @deprecated 改用 validateAsync
   */`);
  eq(js.params.instance, { type: 'object', doc: '待校验对象', optional: false }, '解析 @param（类型/说明/必填）');
  eq(js.params.options, { type: 'object', doc: '选项', optional: true }, '@param [options] 判为可选（JS 源码里没有 ? 可依据）');
  eq(js.params.limit.optional, 'true' === 'true', '@param [limit=10] 默认值写法同样判为可选');
  eq(js.returns, { type: 'object', doc: '校验结果' }, '解析 @returns 的类型与说明');
  eq(js.throws[0], { type: 'SchemaError', doc: 'schema 非法时抛出' }, '解析 @throws');
  eq(js.since, '2.0.0', '解析 @since');
  check(js.deprecated === true, '识别 @deprecated');

  const params = parseParamList('(instance, schema, options, ctx)', {});
  eq(params.map((p) => p.name), ['instance', 'schema', 'options', 'ctx'], '四个普通参数');
  eq(params.every((p) => p.type === '' && !p.optional), true, '无签名类型/无 JSDoc 时类型为空（不编造）');
  const typed = parseParamList('(a: string, b?: number, c: number = 3, ...rest: string[])', {});
  eq(typed.map((p) => [p.name, p.type, p.optional, p.defaultValue]), [
    ['a', 'string', false, ''], ['b', 'number', true, ''], ['c', 'number', false, '3'], ['rest', 'string[]', false, ''],
  ], '类型/可选/默认值/剩余参数');
  const nested = parseParamList('(x: Map<string, number>, cb: (a: number) => void, o: {a: 1})', {});
  eq(nested.map((p) => p.name), ['x', 'cb', 'o'], '★ 嵌套泛型/箭头函数类型/对象类型不会在逗号处被拆错（曾因 `=>` 把 depth 减成负数而漏参数）');
  eq(nested[2].type, '{a: 1}', '对象类型参数的类型被完整保留');
  const arrows = parseParamList('(a: (x: number) => void, b: string)', {});
  eq(arrows.map((p) => p.name), ['a', 'b'], '★ 箭头函数类型之后的参数不会被吞掉');
  const generics = parseParamList('(a: Map<string, Array<number>>, b: number)', {});
  eq(generics.map((p) => p.name), ['a', 'b'], '嵌套泛型（>> 连续闭合）不会让后续参数丢失');
  // 打包产物里类型只在 JSDoc：必须合并进来，否则参数全是光秃秃的名字
  const merged = parseParamList('(instance, schema, options)', {
    instance: { type: 'object', doc: '待校验对象', optional: false },
    options: { type: 'object', doc: '选项', optional: true },
  });
  eq(merged.map((p) => [p.name, p.type, p.optional, p.doc]), [
    ['instance', 'object', false, '待校验对象'], ['schema', '', false, ''], ['options', 'object', true, '选项'],
  ], 'JSDoc 的类型/可选性/说明被合并进参数');
  // 签名里的类型优先于 JSDoc
  const priority = parseParamList('(a: string)', { a: { type: 'number', doc: '', optional: false } });
  eq(priority[0].type, 'string', '签名里的类型优先于 JSDoc');
  check(parseParamList('()').length === 0, '空参数表返回空数组');
}

// ---------- 4. 定义体提取 ----------
console.log('\n— 定义体提取（TS/ArkTS 与打包 JS 两种形态）—');
{
  const ts = `/**
 * 校验器
 */
export class Validator {
  validate(instance: any, schema: any): ValidatorResult { return null as any; }
}`;
  const d1 = extractDefinition(ts, 'Validator');
  check(d1.found && d1.kind === 'class', 'class 声明识别为 class', `${d1.kind} @${d1.line}`);
  check(!d1.deprecated && d1.params.length === 0, '类的构造参数为空');
  const fts = `/*** 校验 */
export function validate(instance: object, schema: object, options?: object): object { return {}; }`;
  const d2 = extractDefinition(fts, 'validate');
  eq(d2.params.map((p) => p.name), ['instance', 'schema', 'options'], 'function 声明的参数');
  eq(d2.returns.type, 'object', 'function 声明的返回类型');
  check(d2.line === 2, 'function 的行号正确', `line=${d2.line}`);
  const arrow = 'export const scan = (base: string, schema: object): Scan => null as any;';
  const d3 = extractDefinition(arrow, 'scan');
  eq(d3.params.map((p) => p.name), ['base', 'schema'], '箭头函数赋值的参数');
  eq(d3.kind, 'function', '箭头函数识别为 function');
  const iface = 'export interface Options { required: boolean; }';
  check(extractDefinition(iface, 'Options').kind === 'interface', 'interface 识别为 interface');
  const en = 'export enum Level { A, B }';
  check(extractDefinition(en, 'Level').kind === 'enum', 'enum 识别为 enum');
  const talias = 'export type Schema = boolean | object;';
  check(extractDefinition(talias, 'Schema').kind === 'type', 'type 别名识别为 type');

  // 打包产物形态：var X = function X() {} + X.prototype.m = function() {}
  const bundle = `/**
 * Creates a new Validator object
 */
var Validator = function Validator() {
  this.schemas = {};
};
Validator.prototype.addSchema = function addSchema(schema, id) { return this; };
Validator.prototype.validate = function validate(instance, schema) { return null; };`;
  const d4 = extractDefinition(bundle, 'Validator');
  check(d4.kind === 'class', '打包产物里 `var X = function X(){}` + 原型方法 → 判为 class', d4.kind);
  eq(d4.methods, ['addSchema', 'validate'], '类的方法清单（原型方法）被收集');
  check(d4.signature.includes('new Validator'), '类签名渲染为 new X(...)', d4.signature);

  // ★ 原型上的**属性**不是方法：方法清单会被喂给用例 Agent 当"可测单元"，
  // 把 customFormats 这类字段当方法会让它写出"调用 customFormats()"这种不存在的东西
  const withProps = extractDefinition(`var Validator = function Validator() {};
Validator.prototype.customFormats = {};
Validator.prototype.schemas = 0;
Validator.prototype.validate = function validate(a) { return a; };
Validator.prototype.check = async (x) => x;`, 'Validator');
  eq(withProps.methods, ['validate', 'check'], '★ 原型属性（customFormats/schemas）不算方法，只收函数赋值');

  // 找不到就诚实返回 found=false，不编造
  const none = extractDefinition(ts, 'NotExistAnywhere');
  check(none.found === false && none.signature === '' && none.params.length === 0, '找不到定义体时 found=false 且不编造签名');

  // ★ 打包产物最常见的形态：`var X = (exports.X = function X(msg, schema) {...})`
  // 函数关键字离 `=` 有几十个字符，用固定小窗口会漏判 → 参数丢失、类被判成常量
  const wrapped = `var SchemaError = (exports.SchemaError = function SchemaError(msg, schema) {
  this.message = msg;
});
SchemaError.prototype.toString = function toString() { return this.message; };`;
  const d5 = extractDefinition(wrapped, 'SchemaError');
  eq(d5.params.map((p) => p.name), ['msg', 'schema'], '★ 带 exports 包裹的赋值函数表达式能读出参数');
  check(d5.kind === 'class', '★ 带原型方法的包裹赋值判为 class', d5.kind);
  const plain = extractDefinition('var helper = function helper(a, b) { return a; };', 'helper');
  eq(plain.params.map((p) => p.name), ['a', 'b'], '普通赋值函数表达式参数正确');
  eq(plain.kind, 'function', '无原型方法的赋值函数判为 function');
  eq(plain.line, 1, '行号正确');
  // 赋值语句结束后面的函数不属于它
  const later = extractDefinition('var cfg = { a: 1 };\nfunction other() {}', 'cfg');
  check(later.kind === 'const' && later.params.length === 0, '赋值语句之后的函数不会被算进这个常量');
}

// ---------- 5. 导出语句解析 ----------
console.log('\n— 导出语句解析（多行/别名/type/export */JS 兼容）—');
{
  const src = [
    `export { Validator,`,
    `  ValidatorResult as Result,`,
    `  ValidatorResultError } from './src/main/js/jsonschema'`,
    '',
    `export type {`,
    `  Schema,`,
    `  Options } from './src/main/js/jsonschema'`,
    '',
    `export * from './extra'`,
    `export * as ns from './ns'`,
    `export class Inline {}`,
    `export const VERSION = '2.0.2'`,
    `exports.legacy = function () {}`,
    `module.exports.also = 1`,
    `const notExported = 1`,
    `const fake = 'export { Ghost } from "./ghost"'`,
  ].join('\n');
  const { exports: ex, stars } = parseExports(src, '/x/index.ts');
  const names = ex.filter((e) => !e.typeOnly).map((e) => e.name).sort();
  eq(names, ['Inline', 'Result', 'VERSION', 'Validator', 'ValidatorResultError', 'also', 'legacy'].sort(), '值导出名单');
  const typeNames = ex.filter((e) => e.typeOnly).map((e) => e.name).sort();
  eq(typeNames, ['Options', 'Schema'], 'type 导出被单独标记');
  eq(ex.find((e) => e.name === 'Result')?.localName, 'ValidatorResult', '别名 a as B 记下原名');
  eq(ex.find((e) => e.name === 'Validator')?.spec, './src/main/js/jsonschema', '多行导出的模块说明符被读出（这里踩过坑）');
  check(ex.every((e) => e.name !== 'Ghost'), '字符串里的假 export 不会被解析出来');
  check(ex.every((e) => e.name !== 'notExported'), '非 export 的声明不会混进来');
  eq(stars.map((s) => s.spec), ['./extra', './ns'], 'export * 与 export * as 的说明符');
}

// ---------- 6. 端到端：合成工程 ----------
console.log('\n— 端到端（合成工程：入口 → 逐层 export → demo 调用点）—');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-p2-'));
{
  const lib = path.join(tmp, 'demo-lib');
  fs.mkdirSync(path.join(lib, 'library/src/main/js'), { recursive: true });
  fs.mkdirSync(path.join(lib, 'entry/src/main/ets/pages'), { recursive: true });
  fs.mkdirSync(path.join(lib, 'entry/src/main/resources/base/profile'), { recursive: true });
  fs.writeFileSync(path.join(lib, 'library/oh-package.json5'),
    `{ name: '@demo/lib', main: 'index.ts', types: '', version: '1.0.0' }`);
  fs.writeFileSync(path.join(lib, 'library/index.ts'),
    `export { Widget, widget, helper } from './src/main/js/impl'\nexport type { Opts } from './src/main/js/impl'\n`);
  fs.writeFileSync(path.join(lib, 'library/src/main/js/impl.js'), [
    `/**`,
    ` * 组件`,
    ` * @constructor`,
    ` */`,
    `var Widget = function Widget(name, opts) { this.name = name; };`,
    `Widget.prototype.render = function render() { return 1; };`,
    `/**`,
    ` * 便捷方法`,
    ` * @param {string} a 参数 a`,
    ` * @param {object} [b] 可选的 b`,
    ` * @returns {number} 结果`,
    ` * @throws {Error} a 为空时`,
    ` */`,
    `function helper(a, b) { return 1; }`,
    `var widget = new Widget('x');`,
  ].join('\n'));
  fs.writeFileSync(path.join(lib, 'entry/oh-package.json5'), `{ name: 'entry', dependencies: { '@demo/lib': 'file:../library' } }`);
  fs.writeFileSync(path.join(lib, 'entry/src/main/resources/base/profile/main_pages.json'),
    JSON.stringify({ src: ['pages/Index', 'pages/HomePage'] }));
  fs.writeFileSync(path.join(lib, 'entry/src/main/ets/pages/Index.ets'), [
    `import { Widget, helper } from '@demo/lib'`,
    `@Entry`,
    `@Component`,
    `struct Index {`,
    `  @State code: string = \`helper(1, 2)\``,   // 展示用样例代码：长得像调用，但不是调用
    `  build() {`,
    `    Column() {`,
    `      Button('运行')`,
    `      TextInput({ placeholder: 'x' })`,
    `      Text(this.code)`,
    `    }`,
    `  }`,
    `  run() {`,
    `    const r = helper(1)`,                    // 真调用
    `    return new Widget('n')`,
    `  }`,
    `}`,
  ].join('\n'));
  fs.writeFileSync(path.join(lib, 'entry/src/main/ets/pages/HomePage.ets'), [
    `@Entry`,
    `@Component`,
    `struct HomePage {`,
    `  build() { Column() { Text('无库调用') } }`,
    `}`,
  ].join('\n'));
  // Hypium 单元测试：能调通不等于**真机页面**覆盖到了，必须与 demo 调用点分开
  fs.mkdirSync(path.join(lib, 'entry/src/ohosTest/ets/test'), { recursive: true });
  fs.writeFileSync(path.join(lib, 'entry/src/ohosTest/ets/test/Widget.test.ets'), [
    `import { helper } from '@demo/lib'`,
    `describe('widget', () => {`,
    `  it('works', () => { helper(9) })`,
    `})`,
  ].join('\n'));

  const entry = resolveEntryFile(lib);
  check(!!entry, '入口解析成功');
  eq(entry.entryRel, 'library/index.ts', '入口取清单 main 字段');
  check(entry.via.includes('main='), '记录入口依据（可追溯）', entry.via);
  eq(entry.packageName, '@demo/lib', '读出库包名（demo 调用点靠它匹配）');

  const { symbols, problems, filesScanned } = collectSymbolsFromEntry(lib, entry.entryAbs);
  eq(symbols.map((s) => s.name).sort(), ['Opts', 'Widget', 'helper', 'widget'], '符号名单（含 type 导出单独一条）');
  const w = symbols.find((s) => s.name === 'Widget');
  check(w.kind === 'class' && w.methods.includes('render'), 'Widget 判为类并带方法', `${w.kind} methods=${JSON.stringify(w.methods)}`);
  eq(w.sourceFile, 'library/src/main/js/impl.js', '定义体定位到 re-export 指向的文件（不是桶文件）');
  check(w.sourceLine === 5, '定义行号正确', `line=${w.sourceLine}`);
  check(w.signature.includes('new Widget'), '类签名渲染为 new X(...)', w.signature);
  const h = symbols.find((s) => s.name === 'helper');
  eq(h.params.map((p) => [p.name, p.type, p.optional]), [['a', 'string', false], ['b', 'object', true]], 'helper 参数（类型来自 JSDoc，[b] 判为可选）');
  eq(h.params[0].doc, '参数 a', 'JSDoc 参数说明合并进参数');
  eq(h.returns, { type: 'number', doc: '结果' }, '返回类型来自 JSDoc');
  eq(h.throws[0], { type: 'Error', doc: 'a 为空时' }, '@throws 被记录');
  check(symbols.find((s) => s.name === 'Opts')?.kind === 'type', 'type 导出记成 type');
  check(filesScanned >= 1, '扫描文件数被统计', `filesScanned=${filesScanned}`);
  // 只声明在本库不存在的类型文件里的类型符号 → 必须作为问题报出来，而不是假装有签名
  check(problems.length === 1 && problems[0].includes('Opts'), '找不到定义体的符号被列进问题（只有 Opts 一条）', JSON.stringify(problems));

  const demoMod = findDemoModuleDir(lib);
  eq(findDemoModuleDir(lib), path.join(lib, 'entry'), 'demo 模块目录 = entry');
  eq(readPageRoutes(demoMod), ['pages/Index', 'pages/HomePage'], '页面路由来自 main_pages.json（不是猜文件名）');
  const { assets } = collectDemoAssets(lib, demoMod);
  eq(assets.filter((a) => a.kind === 'page').map((a) => a.pagePath).sort(), ['pages/HomePage', 'pages/Index'], '两个页面都登记为 page 资产');
  check(assets.some((a) => a.kind === 'param' && a.name === 'code'), 'State 模板字面量登记为 param 资产');
  eq(assets.filter((a) => a.kind === 'control').map((a) => a.name.split('@')[0]).sort(), ['Button', 'TextInput'], '可交互控件登记为 control 资产');

  const calls = collectCallSites(lib, path.join(lib, 'entry'), entry.packageName, symbols);
  // 这是本套自检最重要的一条：demo 页面里的"展示用样例代码字符串"长得像调用，
  // 若把它算成调用点，就会得出"该接口已被 demo 覆盖"的假结论（真机根本不会执行到）。
  const helperCalls = calls.assets.filter((a) => a.name === 'helper' && a.kind === 'call');
  check(!calls.assets.some((a) => a.name === 'helper' && a.sourceLine === 5), '★ 模板字符串里的 helper(1, 2) 不算调用点（否则是假覆盖）',
    JSON.stringify(calls.assets.filter((a) => a.name === 'helper').map((a) => `${a.sourceFile}:${a.sourceLine}:${a.kind}`)));
  eq(helperCalls.map((a) => [a.sourceLine, a.kind, a.mutability, a.pagePath]), [[14, 'call', 'code', 'pages/Index']], '★ 函数体里的真调用被找到（kind=call / mutability=code）');
  eq(calls.assets.filter((a) => a.name === 'Widget' && a.kind === 'call').map((a) => a.sourceLine), [15], 'new Widget(...) 的调用点也被找到');
  check(!calls.assets.some((a) => a.sourceFile.includes('HomePage')), '没有调用库的页面不产生调用点');
  check(calls.assets.filter((a) => a.sourceFile.includes('/src/main/')).every((a) => a.kind === 'call'), 'src/main 下的调用点一律是 call');
  // ★ 单元测试的调用必须单独归类：否则"有单元测试"会被当成"真机 demo 已覆盖"
  const testCalls = calls.assets.filter((a) => a.kind === 'test_call');
  eq(testCalls.map((a) => [a.name, a.pagePath]), [['helper', '']], '★ src/ohosTest 下的调用标为 test_call 且 pagePath 为空（不是真机页面）');
  check(calls.problems.some((p) => p.includes('Hypium 单元测试')), '单元测试调用被单独提示出来', JSON.stringify(calls.problems));
  eq(sourceScope(path.join(lib, 'entry/src/ohosTest/ets/test/Widget.test.ets')), 'test', 'sourceScope 识别单元测试目录');
  eq(sourceScope(path.join(lib, 'entry/src/main/ets/pages/Index.ets')), 'main', 'sourceScope 识别真机 demo 目录');

  const full = extractLibraryApi(lib);
  check(full.symbols.length === 4 && full.demoAssets.length > 0, '编排结果：4 个符号 + demo 资产', `symbols=${full.symbols.length} assets=${full.demoAssets.length}`);
  const seenKeys = new Set(full.demoAssets.map((a) => `${a.kind}|${a.name}|${a.sourceFile}|${a.sourceLine}`));
  check(seenKeys.size === full.demoAssets.length, 'demo 资产去重（同 kind+name+file+line 只留一条）');
  const md = renderApiDoc({ name: 'demo-lib' }, full, '1.0.0');
  check(md.includes('# demo-lib · 接口清单') && md.includes('`Widget`') && md.includes('@demo/lib'), '《接口清单.md》含标题/符号/包名');
  check(md.includes('demo 资产') && md.includes('pages/Index'), '《接口清单.md》含 demo 资产段');
}

// ---------- 7. 边界与失败路径 ----------
console.log('\n— 边界与失败路径 —');
{
  const empty = path.join(tmp, 'empty-lib');
  fs.mkdirSync(empty, { recursive: true });
  const r = extractLibraryApi(empty);
  check(r.symbols.length === 0 && r.problems.length === 1 && r.problems[0].includes('未找到库入口'), '空目录：明确报"未找到库入口"而不是抛异常', r.problems[0]);

  const bad = path.join(tmp, 'bad-lib');
  fs.mkdirSync(path.join(bad, 'library'), { recursive: true });
  fs.writeFileSync(path.join(bad, 'library/oh-package.json5'), `{ name: '@demo/bad', main: 'index.ts' }`);
  fs.writeFileSync(path.join(bad, 'library/index.ts'), `export { A } from './missing-file'\n`);
  const r2 = extractLibraryApi(bad);
  check(r2.problems.some((p) => p.includes('无法解析到文件')), '★ 相对路径 re-export 找不到文件 → 报"符号会丢失"（不静默丢）', JSON.stringify(r2.problems));
  check(!r2.problems.some((p) => p.includes('不是相对路径')), '★ 不会把"相对路径找不到"误报成"外部依赖"', JSON.stringify(r2.problems));

  const ext = path.join(tmp, 'ext-lib');
  fs.mkdirSync(path.join(ext, 'library'), { recursive: true });
  fs.writeFileSync(path.join(ext, 'library/oh-package.json5'), `{ name: '@demo/ext', main: 'index.ts' }`);
  fs.writeFileSync(path.join(ext, 'library/index.ts'), `export { Something } from '@ohos.someExternal'\n`);
  const r3 = extractLibraryApi(ext);
  check(r3.problems.some((p) => p.includes('外部依赖跳过')), '外部包 re-export 记为信息（不是本库接口面）', JSON.stringify(r3.problems));

  // 非相对说明符解析
  check(resolveRelativeSpec('/a/b/index.ts', '@ohos/x') === null, '非相对说明符返回 null');
  check(resolveFileLike(path.join(bad, 'library/index')) === path.join(bad, 'library/index.ts'), '补扩展名解析到真实文件');
  check(resolveFileLike(path.join(bad, 'library/nope')) === null, '不存在的路径返回 null');

  // JSDoc 边界
  check(parseJsdoc('').summary === '' && parseJsdoc('').throws.length === 0, '空 JSDoc 不报错');
  check(jsdocBefore('const a = 1;', 0).text === '', '代码前面没有 JSDoc 时返回空');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '全部通过' : `${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
