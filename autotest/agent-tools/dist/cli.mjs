#!/usr/bin/env node

// ../agent-tools/src/core/envelope.ts
var EXIT = {
  OK: 0,
  /** 本地校验失败：请求未发出（命令不存在 / 参数缺失 / 组合非法） */
  LOCAL_VALIDATION: 2,
  /** 服务端拒绝：业务错误（403 权限不足 / 404 / 409 审批中 / 5xx） */
  REJECTED: 3,
  /** 认证失败：401 / 令牌缺失或无效 */
  UNAUTHORIZED: 4,
  /** 传输失败：网络不可达 / 超时 / 响应非 JSON */
  TRANSPORT: 5
};
var LocalValidationError = class extends Error {
  code = "LOCAL_VALIDATION";
  statusCode = 2;
  constructor(message) {
    super(message);
    this.name = "LocalValidationError";
  }
};
var ApiError = class extends Error {
  constructor(statusCode, code, message, hint) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.hint = hint;
    this.name = "ApiError";
  }
  statusCode;
  code;
  hint;
};
function emitOk(command, data, meta, opts = {}) {
  const env = { ok: true, command, data, meta };
  const out = opts.stdout ?? ((s) => process.stdout.write(s));
  out(`${JSON.stringify(env, null, opts.pretty ? 2 : void 0)}
`);
}
function emitErr(command, error, opts = {}) {
  const env = { ok: false, command, error };
  const err = opts.stderr ?? ((s) => process.stderr.write(s));
  err(`${JSON.stringify(env, null, opts.pretty ? 2 : void 0)}
`);
}
var EXIT_TABLE = [
  { code: EXIT.OK, name: "OK", when: "\u6210\u529F" },
  { code: EXIT.LOCAL_VALIDATION, name: "LOCAL_VALIDATION", when: "\u672C\u5730\u6821\u9A8C\u5931\u8D25\uFF08\u547D\u4EE4\u4E0D\u5B58\u5728/\u53C2\u6570\u7F3A\u5931/\u7EC4\u5408\u975E\u6CD5\uFF09\uFF0C\u8BF7\u6C42\u672A\u53D1\u51FA" },
  { code: EXIT.REJECTED, name: "REJECTED", when: "\u670D\u52A1\u7AEF\u4E1A\u52A1\u62D2\u7EDD\uFF08403 \u6743\u9650\u4E0D\u8DB3 / 404 \u4E0D\u5B58\u5728 / 409 \u5BA1\u6279\u4E2D / 5xx \u670D\u52A1\u7AEF\u9519\u8BEF\uFF09" },
  { code: EXIT.UNAUTHORIZED, name: "UNAUTHORIZED", when: "\u8BA4\u8BC1\u5931\u8D25\uFF08401 \u6216\u4EE4\u724C\u7F3A\u5931/\u65E0\u6548\uFF09" },
  { code: EXIT.TRANSPORT, name: "TRANSPORT", when: "\u4F20\u8F93\u5931\u8D25\uFF08\u7F51\u7EDC\u4E0D\u53EF\u8FBE / \u8D85\u65F6 / \u54CD\u5E94\u975E JSON\uFF09" }
];
function exitCodeFor(err) {
  switch (err.code) {
    case "UNAUTHORIZED":
      return EXIT.UNAUTHORIZED;
    case "NETWORK_ERROR":
    case "TIMEOUT":
    case "BAD_RESPONSE":
      return EXIT.TRANSPORT;
    default:
      return EXIT.REJECTED;
  }
}

// ../agent-tools/src/commands/index.ts
var COMMANDS = [
  // ---------- health ----------
  {
    name: "health.check",
    group: "health",
    action: "check",
    summary: "\u670D\u52A1\u5065\u5EB7\u68C0\u67E5\uFF08\u7248\u672C / \u6570\u636E\u5E93\u5F15\u64CE / \u8DEF\u7531\u6570\uFF09",
    method: "GET",
    path: "/health",
    role: "viewer",
    params: []
  },
  // ---------- rules（B3：编码时纪律注入） ----------
  {
    name: "rules.inject",
    group: "rules",
    action: "inject",
    summary: "\u89C4\u5219\u6CE8\u5165\uFF1A\u6309\u89E6\u78B0\u7684\u8DEF\u5F84/\u4E3B\u9898\u8FD4\u56DE\u5F00\u53D1\u7EAA\u5F8B\u6587\u672C\uFF08\u5582\u7ED9\u7F16\u7801 agent\uFF09",
    method: "GET",
    path: "/rules/inject",
    role: "viewer",
    params: [
      { name: "paths", type: "string-array", description: "\u53D8\u66F4\u6587\u4EF6\u8DEF\u5F84\uFF08\u9017\u53F7\u5206\u9694\uFF1Bglob \u547D\u4E2D inject_when.paths\uFF09" },
      { name: "touches", type: "string-array", description: "\u89E6\u78B0\u4E3B\u9898\u6807\u7B7E\uFF08\u9017\u53F7\u5206\u9694\uFF0C\u5982 transaction,secrets\uFF09" },
      { name: "budgetChars", type: "number", description: "\u6CE8\u5165\u9884\u7B97\uFF08\u5B57\u7B26\uFF09\uFF0C\u9ED8\u8BA4 8000" }
    ]
  },
  // ---------- libraries ----------
  {
    name: "libraries.list",
    group: "libraries",
    action: "list",
    summary: "\u4E09\u65B9\u5E93\u5217\u8868\uFF08\u5206\u9875 / \u641C\u7D22\uFF09",
    method: "GET",
    path: "/libraries",
    role: "viewer",
    params: [
      { name: "page", type: "number", description: "\u9875\u7801\uFF0C\u9ED8\u8BA4 1", default: 1 },
      { name: "pageSize", type: "number", description: "\u6BCF\u9875\u6761\u6570\uFF08\u2264100\uFF09\uFF0C\u9ED8\u8BA4 20", default: 20 },
      { name: "q", type: "string", description: "\u540D\u79F0/\u7B80\u4ECB\u6A21\u7CCA\u641C\u7D22" }
    ]
  },
  {
    name: "libraries.get",
    group: "libraries",
    action: "get",
    summary: "\u4E09\u65B9\u5E93\u8BE6\u60C5\uFF08\u542B\u7528\u4F8B\u6570\uFF09",
    method: "GET",
    path: "/libraries/:id",
    role: "viewer",
    params: []
  },
  {
    name: "libraries.create",
    group: "libraries",
    action: "create",
    summary: "\u65B0\u5EFA\u4E09\u65B9\u5E93\uFF08\u4ED3\u5E93\u5730\u5740\u53EF\u9009\uFF0C\u540E\u7EED\u53EF\u62C9\u53D6\uFF09",
    method: "POST",
    path: "/libraries",
    role: "operator",
    params: [
      { name: "name", type: "string", required: true, description: "\u5E93\u540D\u79F0" },
      { name: "repoUrl", type: "string", description: "\u4ED3\u5E93\u5730\u5740\uFF08http/https/git/ssh\uFF09" },
      { name: "repoSubpath", type: "string", description: "\u5355\u4F53\u4ED3\u5185\u7684\u5B50\u76EE\u5F55" },
      { name: "description", type: "string", description: "\u5E93\u7B80\u4ECB" },
      { name: "packageName", type: "string", description: "bundleName" },
      { name: "mainAbility", type: "string", description: "\u5165\u53E3 Ability" }
    ]
  },
  {
    name: "libraries.update",
    group: "libraries",
    action: "update",
    summary: "\u66F4\u65B0\u4E09\u65B9\u5E93\u4FE1\u606F",
    method: "PUT",
    path: "/libraries/:id",
    role: "operator",
    params: [
      { name: "name", type: "string", description: "\u5E93\u540D\u79F0" },
      { name: "repoUrl", type: "string", description: "\u4ED3\u5E93\u5730\u5740" },
      { name: "repoSubpath", type: "string", description: "\u5355\u4F53\u4ED3\u5B50\u76EE\u5F55" },
      { name: "description", type: "string", description: "\u5E93\u7B80\u4ECB" },
      { name: "packageName", type: "string", description: "bundleName" },
      { name: "mainAbility", type: "string", description: "\u5165\u53E3 Ability" },
      { name: "status", type: "string", description: "\u72B6\u6001", enum: ["active", "archived"] }
    ]
  },
  {
    name: "libraries.delete",
    group: "libraries",
    action: "delete",
    summary: "\u5220\u9664\u4E09\u65B9\u5E93\uFF08\u7EA7\u8054\u5220\u9664\u7528\u4F8B\u4E0E\u6267\u884C\u5386\u53F2\uFF09",
    method: "DELETE",
    path: "/libraries/:id",
    role: "operator",
    dangerous: true,
    params: [
      { name: "force", type: "boolean", description: "\u6709\u5173\u8054\u6570\u636E\u65F6\u5F3A\u5236\u5220\u9664\uFF08\u5426\u5219 409 \u5E26\u56DE\u5F71\u54CD\u9762\uFF09" }
    ]
  },
  {
    name: "libraries.sheet",
    group: "libraries",
    action: "sheet",
    summary: "\u4E09\u65B9\u5E93\u6D4B\u8BD5\u8868\uFF08xlsx\uFF09\u4FE1\u606F\uFF08\u8DEF\u5F84 / \u662F\u5426\u5B58\u5728\uFF09",
    method: "GET",
    path: "/libraries/sheet",
    role: "viewer",
    params: []
  },
  {
    name: "libraries.sync-sheet",
    group: "libraries",
    action: "sync-sheet",
    summary: "\u4ECE xlsx \u540C\u6B65\u5E93\u6E05\u5355\uFF08apply=false \u53EA\u9884\u89C8\u5DEE\u5F02\uFF09",
    method: "POST",
    path: "/libraries/sync-sheet",
    role: "operator",
    params: [
      { name: "file", type: "string", description: "xlsx \u8DEF\u5F84\uFF08\u7F3A\u7701\u7528\u914D\u7F6E\u8DEF\u5F84\uFF09" },
      { name: "apply", type: "boolean", description: "true=\u5B9E\u9645\u5199\u5165\uFF0Cfalse=\u9884\u89C8", default: false }
    ]
  },
  // ---------- cases ----------
  {
    name: "cases.list",
    group: "cases",
    action: "list",
    summary: "\u7528\u4F8B\u5217\u8868\uFF08\u6309\u5E93\uFF0C\u5206\u9875 / \u641C\u7D22 / \u8FC7\u6EE4\uFF09",
    method: "GET",
    path: "/libraries/:id/cases",
    role: "viewer",
    params: [
      { name: "page", type: "number", description: "\u9875\u7801", default: 1 },
      { name: "pageSize", type: "number", description: "\u6BCF\u9875\u6761\u6570\uFF08\u2264100\uFF09", default: 20 },
      { name: "q", type: "string", description: "\u7528\u4F8B\u53F7/\u540D\u79F0\u641C\u7D22" },
      { name: "source", type: "string", description: "\u6765\u6E90\u8FC7\u6EE4" },
      { name: "status", type: "string", description: "\u72B6\u6001\u8FC7\u6EE4" }
    ]
  },
  {
    name: "cases.get",
    group: "cases",
    action: "get",
    summary: "\u7528\u4F8B\u8BE6\u60C5\uFF08\u6B65\u9AA4 / \u9884\u671F / \u5224\u636E\uFF09",
    method: "GET",
    path: "/cases/:id",
    role: "viewer",
    params: []
  },
  {
    name: "cases.create",
    group: "cases",
    action: "create",
    summary: "\u65B0\u5EFA\u6D4B\u8BD5\u7528\u4F8B",
    method: "POST",
    path: "/cases",
    role: "operator",
    params: [
      { name: "libraryId", type: "number", required: true, description: "\u6240\u5C5E\u5E93 id" },
      { name: "caseNo", type: "string", required: true, description: "\u7528\u4F8B\u7F16\u53F7\uFF08\u5E93\u5185\u552F\u4E00\uFF09" },
      { name: "name", type: "string", required: true, description: "\u7528\u4F8B\u540D\u79F0" },
      { name: "precondition", type: "string", description: "\u524D\u7F6E\u6761\u4EF6" },
      { name: "steps", type: "string-array", description: "\u6B65\u9AA4\uFF08\u9017\u53F7\u5206\u9694\u6216\u591A\u503C\u4F20\u5165\uFF09" },
      { name: "expected", type: "string", description: "\u9884\u671F\u7ED3\u679C" },
      { name: "dtsUrl", type: "string", description: "DTS \u95EE\u9898\u5355\u94FE\u63A5" },
      { name: "status", type: "string", description: "\u72B6\u6001", default: "\u5F85\u786E\u8BA4" }
    ]
  },
  {
    name: "cases.update",
    group: "cases",
    action: "update",
    summary: "\u66F4\u65B0\u7528\u4F8B\uFF08\u81EA\u52A8\u8BB0\u7248\u672C\u5386\u53F2\uFF09",
    method: "PUT",
    path: "/cases/:id",
    role: "operator",
    params: [
      { name: "name", type: "string", description: "\u7528\u4F8B\u540D\u79F0" },
      { name: "precondition", type: "string", description: "\u524D\u7F6E\u6761\u4EF6" },
      { name: "steps", type: "string-array", description: "\u6B65\u9AA4" },
      { name: "expected", type: "string", description: "\u9884\u671F\u7ED3\u679C" },
      { name: "status", type: "string", description: "\u72B6\u6001" },
      { name: "changeNote", type: "string", description: "\u53D8\u66F4\u8BF4\u660E\uFF08\u7248\u672C\u5386\u53F2\uFF09" }
    ]
  },
  {
    name: "cases.delete",
    group: "cases",
    action: "delete",
    summary: "\u5220\u9664\u7528\u4F8B\uFF08\u8FDE\u5E26\u7248\u672C\u4E0E\u6267\u884C\u8BB0\u5F55\uFF09",
    method: "DELETE",
    path: "/cases/:id",
    role: "operator",
    dangerous: true,
    params: []
  },
  {
    name: "cases.optimize",
    group: "cases",
    action: "optimize",
    summary: "AI \u4F18\u5316\u7528\u4F8B\uFF08\u8C03 LLM\uFF0C\u8BA1\u5165\u9650\u6D41\uFF09",
    method: "POST",
    path: "/cases/:id/optimize",
    role: "operator",
    params: []
  },
  {
    name: "cases.rollback",
    group: "cases",
    action: "rollback",
    summary: "\u56DE\u6EDA\u7528\u4F8B\u5230\u5386\u53F2\u7248\u672C",
    method: "POST",
    path: "/cases/:id/rollback",
    role: "operator",
    params: [
      { name: "version", type: "number", required: true, description: "\u76EE\u6807\u7248\u672C\u53F7" },
      { name: "author", type: "string", description: "\u64CD\u4F5C\u4EBA" }
    ]
  },
  {
    name: "cases.export",
    group: "cases",
    action: "export",
    summary: "\u5BFC\u51FA\u7528\u4F8B\u4E3A xlsx\uFF08CLI \u843D\u76D8\u5230 --out\uFF09",
    method: "GET",
    path: "/cases/export",
    role: "viewer",
    binary: true,
    params: [
      { name: "libraryId", type: "number", required: true, description: "\u5E93 id" }
    ]
  },
  {
    name: "cases.import",
    group: "cases",
    action: "import",
    summary: "\u4ECE xlsx\uFF08base64\uFF09\u5BFC\u5165\u7528\u4F8B",
    method: "POST",
    path: "/cases/import",
    role: "operator",
    params: [
      { name: "libraryId", type: "number", required: true, description: "\u76EE\u6807\u5E93 id" },
      { name: "fileName", type: "string", required: true, description: "\u6587\u4EF6\u540D\uFF08\u5982 cases.xlsx\uFF09" },
      { name: "base64", type: "string", required: true, description: "xlsx \u6587\u4EF6\u5185\u5BB9\u7684 base64" }
    ]
  },
  // ---------- tasks ----------
  {
    name: "tasks.list",
    group: "tasks",
    action: "list",
    summary: "AI \u4EFB\u52A1\u5217\u8868\uFF08\u53EF\u6309\u72B6\u6001\u8FC7\u6EE4\uFF09",
    method: "GET",
    path: "/tasks",
    role: "viewer",
    params: [
      { name: "status", type: "string", description: "\u72B6\u6001\u8FC7\u6EE4", enum: ["pending", "running", "done", "failed", "cancelled"] }
    ]
  },
  {
    name: "tasks.get",
    group: "tasks",
    action: "get",
    summary: "\u4EFB\u52A1\u8BE6\u60C5\uFF08\u8FDB\u5EA6 / \u7ED3\u679C / \u9519\u8BEF\uFF09",
    method: "GET",
    path: "/tasks/:id",
    role: "viewer",
    params: []
  },
  {
    name: "tasks.create",
    group: "tasks",
    action: "create",
    summary: "\u521B\u5EFA AI \u4EFB\u52A1\uFF08\u62C9\u4ED3\u5E93/\u5199\u7528\u4F8B/\u904D\u5386/\u8F6C\u811A\u672C\u7B49\uFF09",
    method: "POST",
    path: "/tasks",
    role: "operator",
    params: [
      {
        name: "type",
        type: "string",
        required: true,
        description: "\u4EFB\u52A1\u7C7B\u578B",
        enum: ["pull_repo", "update_repo", "write_cases", "explore_cases", "update_cases", "to_script", "matrix_cases", "integrate_cases"]
      },
      { name: "libraryId", type: "number", description: "\u76EE\u6807\u5E93 id" },
      { name: "input", type: "string", description: "\u4EFB\u52A1\u8F93\u5165\uFF08\u5982\u4ED3\u5E93\u5730\u5740 / \u8865\u5145\u8BF4\u660E\uFF09" },
      { name: "title", type: "string", description: "\u6807\u9898\uFF08\u7F3A\u7701\u6309\u7C7B\u578B\u5F52\u4E00\u5316\uFF09" }
    ]
  },
  {
    name: "tasks.retry",
    group: "tasks",
    action: "retry",
    summary: "\u91CD\u8BD5\u5931\u8D25/\u53D6\u6D88\u7684\u4EFB\u52A1",
    method: "POST",
    path: "/tasks/:id/retry",
    role: "operator",
    params: []
  },
  {
    name: "tasks.cancel",
    group: "tasks",
    action: "cancel",
    summary: "\u53D6\u6D88\u4EFB\u52A1\uFF08\u6392\u961F\u4E2D\u51FA\u961F / \u8FD0\u884C\u4E2D abort\uFF09",
    method: "POST",
    path: "/tasks/:id/cancel",
    role: "operator",
    params: []
  },
  {
    name: "tasks.delete",
    group: "tasks",
    action: "delete",
    summary: "\u5220\u9664\u4EFB\u52A1\uFF08\u8FDE\u5E26\u4E8B\u4EF6\u6D41\uFF09",
    method: "DELETE",
    path: "/tasks/:id",
    role: "operator",
    dangerous: true,
    params: []
  },
  // ---------- plans ----------
  {
    name: "plans.list",
    group: "plans",
    action: "list",
    summary: "\u6267\u884C\u8BA1\u5212\u5217\u8868",
    method: "GET",
    path: "/plans",
    role: "viewer",
    params: [
      { name: "status", type: "string", description: "\u72B6\u6001\u8FC7\u6EE4" }
    ]
  },
  {
    name: "plans.create",
    group: "plans",
    action: "create",
    summary: "\u521B\u5EFA\u6267\u884C\u8BA1\u5212\uFF08\u7ACB\u5373/\u5B9A\u65F6/\u5355\u72EC/\u6279\u91CF/\u5168\u91CF\uFF09",
    method: "POST",
    path: "/plans",
    role: "operator",
    // 服务端读嵌套结构 scope.libraryIds/scope.caseIds——平铺会静默丢参（曾踩过）
    bodyPaths: { libraryIds: "scope.libraryIds", caseIds: "scope.caseIds" },
    params: [
      { name: "name", type: "string", required: true, description: "\u8BA1\u5212\u540D\u79F0" },
      {
        name: "type",
        type: "string",
        required: true,
        description: "\u8BA1\u5212\u7C7B\u578B",
        enum: ["immediate", "scheduled", "single", "batch", "full"]
      },
      { name: "cron", type: "string", description: "cron \u8868\u8FBE\u5F0F\uFF08scheduled \u5FC5\u586B\uFF09" },
      { name: "libraryIds", type: "string-array", description: "\u8303\u56F4\uFF1A\u5E93 id\uFF08\u9017\u53F7\u5206\u9694\uFF09" },
      { name: "caseIds", type: "string-array", description: "\u8303\u56F4\uFF1A\u7528\u4F8B id\uFF08\u9017\u53F7\u5206\u9694\uFF09" },
      { name: "deviceIds", type: "string-array", description: "\u76EE\u6807\u8BBE\u5907 id\uFF08\u9017\u53F7\u5206\u9694\uFF09" },
      { name: "failPolicy", type: "string", description: "\u5931\u8D25\u7B56\u7565", enum: ["continue", "abort", "retry"] },
      { name: "scriptMode", type: "string", description: "\u811A\u672C\u6A21\u5F0F", enum: ["script", "step"] }
    ]
  },
  {
    name: "plans.run",
    group: "plans",
    action: "run",
    summary: "\u7ACB\u5373\u6267\u884C\u8BA1\u5212\uFF08\u771F\u673A\u6267\u884C\uFF0C\u65E0\u5728\u7EBF\u8BBE\u5907\u5C06\u5931\u8D25\uFF09",
    method: "POST",
    path: "/plans/:id/run",
    role: "operator",
    params: []
  },
  // ---------- devices ----------
  {
    name: "devices.list",
    group: "devices",
    action: "list",
    summary: "\u8BBE\u5907\u5217\u8868\uFF08\u5728\u7EBF\u72B6\u6001 / \u578B\u53F7 / \u7CFB\u7EDF\u7248\u672C\uFF09",
    method: "GET",
    path: "/devices",
    role: "viewer",
    params: []
  },
  {
    name: "devices.scan",
    group: "devices",
    action: "scan",
    summary: "\u7ACB\u5373\u626B\u63CF\u4E00\u6B21 hdc \u771F\u673A",
    method: "POST",
    path: "/devices/scan",
    role: "operator",
    params: []
  },
  // ---------- approvals（P0-4 审批队列） ----------
  {
    name: "approvals.list",
    group: "approvals",
    action: "list",
    summary: "\u5371\u9669\u64CD\u4F5C\u5BA1\u6279\u5217\u8868\uFF08\u5F85\u6279/\u5DF2\u6279/\u5DF2\u62D2\uFF09",
    method: "GET",
    path: "/approvals",
    role: "viewer",
    params: [
      { name: "status", type: "string", description: "\u72B6\u6001\u8FC7\u6EE4", enum: ["pending", "approved", "rejected"] }
    ]
  },
  {
    name: "approvals.decide",
    group: "approvals",
    action: "decide",
    summary: "\u5BA1\u6279\u51B3\u7B56\uFF08\u6279\u51C6=\u7B7E\u53D1\u4E00\u6B21\u6027\u653E\u884C\u4EE4\u724C\uFF09",
    method: "POST",
    path: "/approvals/:id/decide",
    role: "operator",
    params: [
      { name: "decision", type: "string", required: true, description: "\u51B3\u7B56", enum: ["approve", "reject"] },
      { name: "reason", type: "string", description: "\u7406\u7531\uFF08\u53EF\u9009\uFF09" },
      { name: "decidedBy", type: "string", description: "\u51B3\u7B56\u4EBA\u6807\u8BC6", default: "agent" }
    ]
  },
  // ---------- auth（附加：agent 自省身份态势） ----------
  {
    name: "auth.status",
    group: "auth",
    action: "status",
    summary: "\u8BA4\u8BC1\u6001\u52BF\uFF08\u662F\u5426\u5F00\u542F / \u56DE\u73AF\u8C41\u514D / \u5F53\u524D\u8EAB\u4EFD\u89D2\u8272\uFF09",
    method: "GET",
    path: "/auth/status",
    role: "viewer",
    params: []
  },
  // ---------- skills（附加：技能供应链锁状态） ----------
  {
    name: "skills.lock-status",
    group: "skills",
    action: "lock-status",
    summary: "\u6280\u80FD\u4F9B\u5E94\u94FE\u9501\u6821\u9A8C\u72B6\u6001\uFF08digest \u4E00\u81F4/\u88AB\u7BE1\u6539/\u672A\u9501\u5B9A\uFF09",
    method: "GET",
    path: "/skills",
    role: "viewer",
    params: []
  },
  // ---------- knowledge（附加：知识检索注入） ----------
  {
    name: "knowledge.retrieve",
    group: "knowledge",
    action: "retrieve",
    summary: "\u77E5\u8BC6\u5E93\u68C0\u7D22\uFF08\u8FD4\u56DE\u53EF\u6CE8\u5165\u7684\u6587\u672C\u4E0E\u547D\u4E2D\u7406\u7531\uFF09",
    method: "POST",
    path: "/knowledge/retrieve",
    role: "operator",
    params: [
      { name: "library", type: "string", description: "\u5E93\u540D\uFF08\u4F5C\u7528\u57DF\uFF09" },
      { name: "apiName", type: "string", description: "\u63A5\u53E3\u540D\uFF08\u4F5C\u7528\u57DF\uFF09" },
      { name: "scenarioKind", type: "string", description: "\u573A\u666F\u7C7B\u578B" },
      { name: "stage", type: "string", description: "agent \u9636\u6BB5" },
      { name: "budgetChars", type: "number", description: "\u6CE8\u5165\u9884\u7B97\uFF08\u5B57\u7B26\uFF09" }
    ]
  }
];

// ../agent-tools/src/core/registry.ts
var byName = new Map(COMMANDS.map((c) => [c.name, c]));
function allCommands() {
  return [...COMMANDS];
}
function getCommand(name) {
  return byName.get(name);
}
function groups() {
  const m = /* @__PURE__ */ new Map();
  for (const c of COMMANDS) {
    if (!m.has(c.group)) m.set(c.group, []);
    m.get(c.group).push(c);
  }
  return [...m.entries()].map(([group, commands]) => ({ group, commands }));
}
function pathParams(spec) {
  return [...spec.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
}
function coerce(p, v) {
  if (typeof v !== "string") return v;
  switch (p.type) {
    case "number": {
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    }
    case "boolean":
      return v === "true" || v === "1";
    case "string-array":
      return v.split(",").map((s) => s.trim()).filter(Boolean);
    default:
      return v;
  }
}
function setPath(obj, dotted, value) {
  const parts = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}
function buildRequest(spec, args) {
  const missing = [];
  for (const p of pathParams(spec)) {
    const v = args[p];
    if (v === void 0 || v === "") missing.push(p);
  }
  for (const p of spec.params) {
    const v = args[p.name];
    if (p.required && (v === void 0 || v === "")) missing.push(p.name);
  }
  if (missing.length > 0) {
    throw new LocalValidationError(`\u7F3A\u5C11\u5FC5\u586B\u53C2\u6570\uFF1A${missing.join(", ")}\uFF08\u53C2\u6570\u7ED3\u6784\u89C1 tools/list \u6216 --help ${spec.name}\uFF09`);
  }
  let path = spec.path;
  for (const p of pathParams(spec)) {
    path = path.replace(`:${p}`, encodeURIComponent(String(args[p])));
  }
  const query = {};
  const body = {};
  for (const p of spec.params) {
    const raw = args[p.name];
    if (raw === void 0 || raw === "") continue;
    const v = coerce(p, raw);
    if (spec.method === "GET") {
      query[p.name] = Array.isArray(v) ? v.join(",") : String(v);
      continue;
    }
    const target = spec.bodyPaths?.[p.name];
    if (target) setPath(body, target, v);
    else body[p.name] = v;
  }
  return { method: spec.method, path, query, body: spec.method === "GET" ? void 0 : body };
}

// ../agent-tools/src/core/client.ts
function classify(status, body) {
  const msg = body?.message || body?.error || `HTTP ${status}`;
  if (status === 401) return { code: "UNAUTHORIZED", message: msg };
  if (status === 403) return { code: "FORBIDDEN", message: msg };
  if (status === 404) return { code: "NOT_FOUND", message: msg };
  if (status === 409) return { code: "APPROVAL_REQUIRED", message: msg };
  if (status >= 500) return { code: "SERVER_ERROR", message: msg };
  return { code: "BUSINESS_ERROR", message: msg };
}
async function apiRequest(client, req) {
  const f = client.fetchImpl ?? fetch;
  const url = new URL(client.baseUrl.replace(/\/+$/, "") + req.path);
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (v !== void 0 && v !== "") url.searchParams.set(k, String(v));
  }
  const headers = { Accept: "application/json" };
  if (req.body !== void 0) headers["Content-Type"] = "application/json";
  if (client.token) headers.Authorization = `Bearer ${client.token}`;
  const t0 = Date.now();
  let res;
  try {
    res = await f(url.toString(), {
      method: req.method,
      headers,
      body: req.body === void 0 ? void 0 : JSON.stringify(req.body),
      signal: AbortSignal.timeout(client.timeoutMs ?? 3e4)
    });
  } catch (e) {
    const err = e;
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new ApiError(0, "TIMEOUT", `\u8BF7\u6C42\u8D85\u65F6\uFF08${client.timeoutMs ?? 3e4}ms\uFF09\uFF1A${url}`);
    }
    throw new ApiError(0, "NETWORK_ERROR", `\u7F51\u7EDC\u9519\u8BEF\uFF1A${err.message}\uFF08${url}\uFF09`);
  }
  const durationMs = Date.now() - t0;
  const contentType = res.headers.get("content-type") ?? "";
  if (res.ok && /octet-stream|openxmlformats|spreadsheet/i.test(contentType)) {
    const buf = Buffer.from(await res.arrayBuffer());
    const fn = /filename="?([^";]+)"?/.exec(res.headers.get("content-disposition") ?? "")?.[1];
    return { data: buf, url: url.toString(), durationMs, statusCode: res.status, binary: true, filename: fn };
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(res.status, "BAD_RESPONSE", `\u54CD\u5E94\u4E0D\u662F\u5408\u6CD5 JSON\uFF08HTTP ${res.status}\uFF09\uFF1A${text.slice(0, 120)}`);
  }
  if (!res.ok) {
    const { code, message } = classify(res.status, json);
    throw new ApiError(res.status, code, message);
  }
  return { data: json, url: url.toString(), durationMs, statusCode: res.status };
}
function resolveClient(opts) {
  return {
    baseUrl: opts.base || process.env.AUTOTEST_BASE_URL || "http://127.0.0.1:3280/api/autotest",
    token: opts.token || process.env.AUTOTEST_TOKEN || void 0
  };
}

// ../agent-tools/src/core/help.ts
var GLOBAL_OPTS = [
  ["--token <key>", "API Key\uFF08\u4E5F\u53EF\u7528\u73AF\u5883\u53D8\u91CF AUTOTEST_TOKEN\uFF09"],
  ["--base <url>", "API \u57FA\u5730\u5740\uFF08\u9ED8\u8BA4 http://127.0.0.1:3280/api/autotest\uFF1B\u4E5F\u53EF\u7528 AUTOTEST_BASE_URL\uFF09"],
  ["--pretty", "\u7F29\u8FDB\u8F93\u51FA JSON envelope"],
  ["--confirm", "\u5371\u9669\u64CD\u4F5C\uFF08\u5220\u9664\u7C7B\uFF09\u663E\u5F0F\u786E\u8BA4\uFF1B\u5BA1\u6279\u6A21\u5F0F\u4E0B\u670D\u52A1\u7AEF\u8FD8\u4F1A\u4E8C\u6B21\u62E6\u622A"],
  ["--out <path>", "\u4E8C\u8FDB\u5236\u5BFC\u51FA\uFF08cases.export\uFF09\u843D\u76D8\u8DEF\u5F84"],
  ["--help [\u547D\u4EE4]", "\u5E2E\u52A9\uFF1B\u5E26\u547D\u4EE4\u540D\u770B\u8BE5\u547D\u4EE4\u53C2\u6570\u8BE6\u60C5"],
  ["--version", "\u6253\u5370\u7248\u672C"]
];
function pad(s, n) {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function renderHelpTree() {
  const lines = [];
  lines.push("AutoTest agent CLI \u2014 \u7ED9 AI Agent Bot \u901A\u8FC7 exec \u8C03\u7528\u7684\u8584\u5BA2\u6237\u7AEF");
  lines.push("");
  lines.push("\u7528\u6CD5\uFF1Acli.mjs <command> [\u4F4D\u7F6E\u53C2\u6570] [--flag value] [\u5168\u5C40\u9009\u9879]");
  lines.push("");
  lines.push("\u5168\u5C40\u9009\u9879\uFF1A");
  for (const [flag, desc] of GLOBAL_OPTS) lines.push(`  ${pad(flag, 16)}${desc}`);
  lines.push("");
  lines.push("\u547D\u4EE4\u7EC4\uFF1A");
  for (const g of groups()) {
    lines.push(`  ${g.group}`);
    for (const c of g.commands) {
      const tags = [c.role, c.dangerous ? "dangerous" : ""].filter(Boolean).join(" \xB7 ");
      lines.push(`    ${pad(c.name, 24)}${c.summary}${tags ? `  [${tags}]` : ""}`);
    }
  }
  lines.push("");
  lines.push(`\u5171 ${allCommands().length} \u6761\u547D\u4EE4\uFF1B\u8BE6\u60C5\uFF1Acli.mjs --help <command> \u6216 cli.mjs help <command>`);
  lines.push("");
  lines.push("\u9000\u51FA\u7801\uFF1A");
  for (const e of EXIT_TABLE) lines.push(`  ${e.code}  ${pad(e.name, 18)}${e.when}`);
  return lines.join("\n");
}
function renderCommandHelp(spec) {
  const lines = [];
  const tags = [`role:${spec.role}`, spec.dangerous ? "dangerous\uFF08\u9700 --confirm\uFF09" : "", spec.binary ? "binary\uFF08--out \u843D\u76D8\uFF09" : ""].filter(Boolean).join(" \xB7 ");
  lines.push(`${spec.name} \u2014 ${spec.summary}`);
  lines.push(`  ${spec.method} ${spec.path}${tags ? `   [${tags}]` : ""}`);
  const pathPs = pathParams(spec);
  const slots = [...pathPs, ...spec.params.filter((p) => p.positional).map((p) => p.name)];
  if (slots.length > 0) {
    lines.push("  \u4F4D\u7F6E\u53C2\u6570\uFF1A");
    slots.forEach((s, i) => lines.push(`    #${i + 1} ${s}`));
  }
  if (spec.params.length > 0) {
    lines.push("  \u53C2\u6570\uFF1A");
    for (const p of spec.params) {
      const attrs = [
        p.required ? "\u5FC5\u586B" : "\u53EF\u9009",
        p.type,
        p.positional ? "\u4F4D\u7F6E\u53C2\u6570" : `--${p.flag ?? p.name}`,
        p.enum ? `\u679A\u4E3E: ${p.enum.join("|")}` : "",
        p.default !== void 0 ? `\u9ED8\u8BA4: ${String(p.default)}` : ""
      ].filter(Boolean).join(" \xB7 ");
      lines.push(`    ${pad(`--${p.flag ?? p.name}`, 22)}${pad(attrs, 46)}${p.description}`);
    }
  } else {
    lines.push("  \u53C2\u6570\uFF1A\uFF08\u65E0\uFF09");
  }
  const exParts = [spec.name];
  for (const s of slots) exParts.push(`<${s}>`);
  for (const p of spec.params.filter((x) => !x.positional && x.required)) exParts.push(`--${p.flag ?? p.name} <${p.name}>`);
  lines.push("");
  lines.push(`  \u793A\u4F8B\uFF1Acli.mjs ${exParts.join(" ")}`);
  return lines.join("\n");
}

// ../agent-tools/src/core/meta.ts
var VERSION = "0.1.0";

// ../agent-tools/src/cli.ts
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
function parseArgv(argv) {
  const flags = {};
  const positionals = [];
  let token;
  let base;
  let out;
  let pretty = false;
  let confirm = false;
  let help = false;
  let version = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pretty") {
      pretty = true;
      continue;
    }
    if (a === "--confirm") {
      confirm = true;
      continue;
    }
    if (a === "--help" || a === "-h") {
      help = true;
      continue;
    }
    if (a === "--version" || a === "-v") {
      version = true;
      continue;
    }
    if (a === "--token") {
      token = argv[++i];
      continue;
    }
    if (a.startsWith("--token=")) {
      token = a.slice(8);
      continue;
    }
    if (a === "--base") {
      base = argv[++i];
      continue;
    }
    if (a.startsWith("--base=")) {
      base = a.slice(7);
      continue;
    }
    if (a === "--out") {
      out = argv[++i];
      continue;
    }
    if (a.startsWith("--out=")) {
      out = a.slice(6);
      continue;
    }
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== void 0 && !next.startsWith("--")) {
        flags[k] = next;
        i++;
      } else flags[k] = "true";
      continue;
    }
    positionals.push(a);
  }
  return { command: positionals[0] ?? "", flags, positionals: positionals.slice(1), opts: { token, base, pretty, confirm, out, help, version } };
}
function bindPositionals(spec, positionals, flags) {
  const args = { ...flags };
  const slots = [...pathParams(spec), ...spec.params.filter((p) => p.positional).map((p) => p.name)];
  positionals.forEach((v, i) => {
    if (slots[i]) args[slots[i]] = v;
  });
  return args;
}
function showHelp(target, pretty) {
  if (target) {
    const spec = getCommand(target);
    if (!spec) {
      emitErr(target, { code: "UNKNOWN_COMMAND", message: `\u672A\u77E5\u547D\u4EE4\uFF1A${target}`, hint: `\u53EF\u7528\u547D\u4EE4\uFF1A${allCommands().map((c) => c.name).join(", ")}` });
      process.exit(EXIT.LOCAL_VALIDATION);
    }
    process.stdout.write(`${renderCommandHelp(spec)}
`);
  } else {
    process.stdout.write(`${renderHelpTree()}
`);
  }
  process.exit(EXIT.OK);
}
async function main() {
  const parsed = parseArgv(process.argv.slice(2));
  const { command } = parsed;
  if (parsed.opts.version) {
    process.stdout.write(`${VERSION}
`);
    process.exit(EXIT.OK);
  }
  const isHelp = parsed.opts.help || command === "help";
  if (isHelp) {
    showHelp(command === "help" ? parsed.positionals[0] ?? "" : command, parsed.opts.pretty);
    return;
  }
  if (!command) {
    process.stderr.write(`${renderHelpTree()}
`);
    process.exit(EXIT.LOCAL_VALIDATION);
  }
  const spec = getCommand(command);
  if (!spec) {
    emitErr(command, {
      code: "UNKNOWN_COMMAND",
      message: `\u672A\u77E5\u547D\u4EE4\uFF1A${command}`,
      hint: `\u53EF\u7528\u547D\u4EE4\u7EC4\uFF1A${groups().map((g) => g.group).join(", ")}\uFF1B\u5168\u90E8\u547D\u4EE4\uFF1A${allCommands().map((c) => c.name).join(", ")}`
    });
    process.exit(EXIT.LOCAL_VALIDATION);
  }
  if (spec.dangerous && !parsed.opts.confirm) {
    emitErr(command, {
      code: "LOCAL_VALIDATION",
      message: `\u5371\u9669\u64CD\u4F5C\u9700 --confirm \u663E\u5F0F\u786E\u8BA4\uFF1A${spec.method} ${spec.path}`,
      hint: "\u786E\u8BA4\u5F71\u54CD\u9762\u540E\u5E26 --confirm \u91CD\u8BD5\uFF1B\u5BA1\u6279\u6A21\u5F0F\u4E0B\u670D\u52A1\u7AEF\u8FD8\u4F1A\u8981\u6C42\u4EBA\u5DE5\u6279\u51C6"
    });
    process.exit(EXIT.LOCAL_VALIDATION);
  }
  const args = bindPositionals(spec, parsed.positionals, parsed.flags);
  try {
    const req = buildRequest(spec, args);
    const client = resolveClient({ base: parsed.opts.base, token: parsed.opts.token });
    const res = await apiRequest(client, req);
    if (res.binary) {
      const buf = res.data;
      const outPath = resolve(parsed.opts.out ?? res.filename ?? `autotest-export-${Date.now()}.xlsx`);
      writeFileSync(outPath, buf);
      emitOk(command, { file: outPath, bytes: buf.length, filename: res.filename ?? null }, { url: res.url, durationMs: res.durationMs }, { pretty: parsed.opts.pretty });
      process.exit(EXIT.OK);
    }
    emitOk(command, res.data, { url: res.url, durationMs: res.durationMs }, { pretty: parsed.opts.pretty });
    process.exit(EXIT.OK);
  } catch (e) {
    if (e instanceof LocalValidationError) {
      emitErr(command, { code: "LOCAL_VALIDATION", message: e.message });
      process.exit(EXIT.LOCAL_VALIDATION);
    }
    if (e instanceof ApiError) {
      const noToken = !parsed.opts.token && !process.env.AUTOTEST_TOKEN;
      emitErr(command, {
        code: e.code,
        message: e.message,
        statusCode: e.statusCode || void 0,
        hint: e.hint ?? (e.code === "UNAUTHORIZED" && noToken ? "\u672A\u914D\u7F6E\u4EE4\u724C\uFF1A--token \u6216\u73AF\u5883\u53D8\u91CF AUTOTEST_TOKEN\uFF08\u670D\u52A1\u7AEF\u300C\u7CFB\u7EDF\u914D\u7F6E \u2192 API Key \u4E0E\u8BBF\u95EE\u63A7\u5236\u300D\u521B\u5EFA\uFF09" : void 0)
      });
      process.exit(exitCodeFor(e));
    }
    emitErr(command, { code: "LOCAL_VALIDATION", message: e.message });
    process.exit(EXIT.LOCAL_VALIDATION);
  }
}
void main();
