// resourcekit 统一出口：测试资源的契约、生成与登记。
//
// 分层：
//   contract.ts  纯函数：资源种类、动画 JSON schema 校验、合成资源生成、CA/DB/fixture 规格
//   registry.ts  IO：登记（幂等 + 版本 + sha256）、复用计数、临期检出
//
// api 层只 import 本文件。
export { RESOURCE_KINDS, RESOURCE_KIND_LABEL, RESOURCE_ORIGINS, validateAnimationJson, synthesizeAnimation, contentHash, DEFAULT_CA_SPEC, CA_EXPIRY_WARN_DAYS, caExpectedArtifacts, synthesizeDbSql, DEFAULT_SERVER_FIXTURES, } from './contract.js';
export { registerResource, registerSyntheticForKind, listResources, bumpReuse, expiringCerts, resourceStoreRoot, } from './registry.js';
