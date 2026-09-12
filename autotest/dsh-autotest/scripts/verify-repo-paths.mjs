// 仓库地址 / 子目录解析的离线自检（无设备、无 LLM、无 DB 依赖）。
// 覆盖本轮「库↔仓库子路径映射」的核心规则：
//   1. `/tree/<分支>/<子目录>` 地址必须拆成仓库根 + 子目录（单体仓子目录库占三方库表 171/269）
//   2. 子目录归一化必须挡住 `..` 逃逸 —— 这里出错就是目录穿越（可读写工作区外文件）
//   3. 同仓的多个库解析到**同一个仓库根**（否则 168 个子目录库各存一份 591MB ≈ 97GB）
//   4. 库目录 = 仓库根 + 子目录；未配仓库地址时退回按库名定位（历史数据兼容）
// 用法：npm run build && npm run verify:repo-paths
import { splitRepoUrl, normalizeSubpath, repoRootDir, repoDirFor } from '../lib/services/gitRepo.js';

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

const MONO = 'https://gitcode.com/openharmony-tpc/openharmony_tpc_samples';

// ---------- 1. 地址拆分 ----------
console.log('— 仓库地址拆分（/tree/<分支>/<子目录>）—');
{
  const a = splitRepoUrl(`${MONO}/tree/master/json-schema`);
  check(a.repoUrl === `${MONO}.git`, '拆出仓库根（去掉 /tree/... 并补 .git）', a.repoUrl);
  check(a.subpath === 'json-schema', '拆出子目录', a.subpath);
  check(a.branch === 'master', '拆出分支名', a.branch);

  const nested = splitRepoUrl(`${MONO}/tree/master/path/to/lib`);
  check(nested.subpath === 'path/to/lib', '多级子目录保留完整路径', nested.subpath);

  const root = splitRepoUrl(MONO);
  check(root.repoUrl === `${MONO}.git` && root.subpath === '' && root.branch === '', '仓库根地址：子目录/分支为空');

  const withGit = splitRepoUrl(`${MONO}.git`);
  check(withGit.repoUrl === `${MONO}.git`, '.git 后缀不重复追加', withGit.repoUrl);

  const blob = splitRepoUrl(`${MONO}/blob/master/json-schema/Index.ets`);
  check(blob.subpath === '' && blob.repoUrl === `${MONO}.git`, '/blob/ 文件地址不当作子目录');

  const empty = splitRepoUrl('');
  check(empty.repoUrl === '' && empty.subpath === '', '空地址返回空值（调用方据此退回按库名定位）');
}

// ---------- 2. 子目录归一化（目录穿越防护）----------
console.log('\n— 子目录归一化（目录穿越防护）—');
{
  check(normalizeSubpath('json-schema') === 'json-schema', '普通子目录原样保留');
  check(normalizeSubpath('/json-schema/') === 'json-schema', '去掉首尾分隔符');
  check(normalizeSubpath('a\\b') === 'a/b', 'Windows 反斜杠归一为 /');
  check(normalizeSubpath('../../etc/passwd') === 'etc/passwd', "'..' 被剔除（不能逃出仓库根）", normalizeSubpath('../../etc/passwd'));
  check(normalizeSubpath('a/../../b') === 'a/b', '夹在中间的 .. 同样被剔除');
  check(normalizeSubpath('C:\\Windows') === 'C:/Windows', '盘符被去掉（相对路径化）');
  check(normalizeSubpath('.') === '' && normalizeSubpath('./') === '', "'.' 归一为空");
  check(!normalizeSubpath('..%2F..%2Fsecret').startsWith('..'), 'URL 编码的 .. 不作为逃逸（编码后是普通字符串）');
}

// ---------- 3. 同仓共享一份克隆 ----------
console.log('\n— 同仓多个库必须共享同一个仓库根 —');
{
  const libs = ['json-schema', 'dayjs', 'lodashDemo', 'RxJS'];
  const roots = libs.map((sub) => repoRootDir(`${MONO}/tree/master/${sub}`));
  check(new Set(roots).size === 1, `${libs.length} 个子目录库解析到同一个仓库根`, roots[0]);
  check(roots[0].endsWith('openharmony_tpc_samples'), '仓库根按仓库名（不是库名）命名', roots[0]);

  const other = repoRootDir('https://gitcode.com/CPF-ApplicationTPC/lottie_turbo');
  check(other.endsWith('lottie_turbo') && other !== roots[0], '不同仓库解析到不同目录');

  // 换组织但同名：目录必须落在同一个位置，否则已有克隆会被当成"没同步过"而重新下载
  // （三方库测试表把地址从 openharmony-tpc/x 改成了 CPF-ApplicationTPC/x，实测会重下 591MB 单体仓）
  const orgA = repoRootDir('https://gitcode.com/openharmony-tpc/openharmony_tpc_samples.git');
  const orgB = repoRootDir('https://gitcode.com/CPF-ApplicationTPC/openharmony_tpc_samples.git');
  check(orgA === orgB, '同名仓库换组织 → 目录不变（复用本地克隆，不重新下载）', orgB);
}

// ---------- 4. 库目录 = 仓库根 + 子目录 ----------
console.log('\n— 库目录解析 —');
{
  const monoLib = { name: 'json-schema', repo_url: `${MONO}/tree/master/json-schema`, repo_subpath: 'json-schema' };
  const dir = repoDirFor(monoLib);
  check(dir.endsWith('openharmony_tpc_samples\\json-schema') || dir.endsWith('openharmony_tpc_samples/json-schema'),
    '单体仓子目录库：库目录 = 仓库根/子目录', dir);

  const rootLib = { name: 'lottie_turbo', repo_url: 'https://gitcode.com/CPF-ApplicationTPC/lottie_turbo', repo_subpath: '' };
  const rdir = repoDirFor(rootLib);
  check(rdir.endsWith('lottie_turbo'), '仓库根库：库目录就是仓库根', rdir);

  const noUrl = { name: 'legacy-lib', repo_url: '', repo_subpath: '' };
  check(repoDirFor(noUrl).endsWith('legacy-lib'), '未配仓库地址：退回按库名定位（历史数据兼容）');

  // 子目录带 .. 时不允许逃出仓库根
  const evil = { name: 'evil', repo_url: 'https://gitcode.com/o/r', repo_subpath: '../../../Windows' };
  const edir = repoDirFor(evil);
  check(!edir.includes('..'), '子目录里的 .. 不会出现在最终路径中', edir);

  // repo_subpath 未写入（undefined）时不能抛异常（老行/部分查询列）
  const undef = { name: 'x', repo_url: 'https://gitcode.com/o/r' };
  check(typeof repoDirFor(undef) === 'string', 'repo_subpath 缺失时不抛异常（老数据兼容）');
}

console.log(`\n${fail === 0 ? '全部通过' : `${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
