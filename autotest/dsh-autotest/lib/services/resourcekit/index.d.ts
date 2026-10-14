export { RESOURCE_KINDS, RESOURCE_KIND_LABEL, RESOURCE_ORIGINS, validateAnimationJson, synthesizeAnimation, contentHash, DEFAULT_CA_SPEC, CA_EXPIRY_WARN_DAYS, caExpectedArtifacts, synthesizeDbSql, DEFAULT_SERVER_FIXTURES, type ResourceKind, type ResourceOrigin, type SchemaProblem, type CaSpec, type DbFixtureSpec, type ServerFixtureSpec, } from './contract.js';
export { registerResource, registerSyntheticForKind, listResources, bumpReuse, expiringCerts, resourceStoreRoot, } from './registry.js';
export type { RegisterInput, ResourceRow } from './registry.js';
