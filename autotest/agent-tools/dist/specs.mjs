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
  },
  // ---------- env（R1：环境纵轴 —— 脚本资产 + 环境画像 + 环境准备） ----------
  {
    name: "env.scripts.list",
    group: "env",
    action: "scripts",
    summary: "\u811A\u672C\u8D44\u4EA7\u5E93\u6E05\u5355\uFF08\u5951\u7EA6/\u5931\u8D25\u5206\u7C7B/\u5BA1\u6279\u7B49\u7EA7/\u6F02\u79FB\u72B6\u6001\uFF09",
    method: "GET",
    path: "/env/scripts",
    role: "viewer",
    params: []
  },
  {
    name: "env.scripts.get",
    group: "env",
    action: "scripts.get",
    summary: "\u5355\u4E2A\u811A\u672C\u8D44\u4EA7\u8BE6\u60C5\uFF08\u542B\u5951\u7EA6\u4E0E\u6821\u9A8C\u95EE\u9898\uFF09",
    method: "GET",
    path: "/env/scripts/:id",
    role: "viewer",
    params: []
  },
  {
    name: "env.scripts.seed",
    group: "env",
    action: "scripts.seed",
    summary: "\u64AD\u79CD\u5185\u7F6E\u811A\u672C\u8D44\u4EA7\uFF08\u5E42\u7B49\uFF1B\u5347\u7EA7\u540E\u65B0\u589E\u811A\u672C\u65F6\u624B\u52A8\u8865\uFF09",
    method: "POST",
    path: "/env/scripts/seed",
    role: "operator",
    params: []
  },
  {
    name: "env.profiles.list",
    group: "env",
    action: "profiles",
    summary: "\u73AF\u5883\u753B\u50CF\u5217\u8868\uFF08\u53EF\u6309\u5E93\u8FC7\u6EE4\uFF09",
    method: "GET",
    path: "/env/profiles",
    role: "viewer",
    params: [
      { name: "libraryId", type: "number", description: "\u6309\u4E09\u65B9\u5E93\u8FC7\u6EE4\uFF080=\u4E0D\u9650\uFF09" }
    ]
  },
  {
    name: "env.profiles.get",
    group: "env",
    action: "profiles.get",
    summary: "\u73AF\u5883\u753B\u50CF\u8BE6\u60C5\uFF08\u542B\u6B65\u9AA4\u5E8F\u5217\uFF09",
    method: "GET",
    path: "/env/profiles/:id",
    role: "viewer",
    params: []
  },
  {
    name: "env.profiles.create",
    group: "env",
    action: "profiles.create",
    summary: "\u65B0\u5EFA\u73AF\u5883\u753B\u50CF\uFF08\u58F0\u660E\u6B65\u9AA4\u5E8F\u5217\uFF1B\u53C2\u6570\u4E0D\u5408\u6CD5\u4F1A\u88AB\u62D2\uFF09",
    method: "POST",
    path: "/env/profiles",
    role: "operator",
    params: [
      { name: "libraryId", type: "number", description: "\u4E09\u65B9\u5E93 id", required: true },
      { name: "name", type: "string", description: "\u753B\u50CF\u540D", required: true },
      { name: "presetKind", type: "string", description: "\u9884\u8BBE\u7C7B\u522B\uFF08animation/network/storage\u2026\uFF09" },
      { name: "toolchain", type: "string", description: "\u5DE5\u5177\u94FE JSON\uFF08deveco-cli \u7248\u672C/SDK/API level\uFF09" },
      { name: "components", type: "string", description: "\u7EC4\u4EF6 JSON\uFF08\u5B50\u6A21\u5757/\u4E8C\u8FDB\u5236\u4F9D\u8D56/ohpm/\u6587\u4EF6\u914D\u7F6E\uFF09" },
      { name: "steps", type: "string", description: "\u6B65\u9AA4 JSON\uFF1A[{scriptId,params,required}]" }
    ]
  },
  {
    name: "env.profiles.run",
    group: "env",
    action: "profiles.run",
    summary: "\u6267\u884C\u73AF\u5883\u51C6\u5907\uFF08\u957F\u4EFB\u52A1\uFF1B\u6307\u7EB9\u547D\u4E2D\u5219\u7F13\u5B58\u590D\u7528\u4E0D\u91CD\u8DD1\uFF09",
    method: "POST",
    path: "/env/profiles/:id/run",
    role: "operator",
    params: [
      { name: "trigger", type: "string", description: "manual/plan/agent/batch" },
      { name: "cwd", type: "string", description: "\u5DE5\u4F5C\u76EE\u5F55\uFF08\u7F3A\u7701\u7528\u5E93\u7684\u4ED3\u5E93\u76EE\u5F55\uFF09" },
      { name: "commit", type: "string", description: "\u4EE3\u7801 commit\uFF08\u8FDB\u6307\u7EB9\uFF09" },
      { name: "allowCache", type: "boolean", description: "\u662F\u5426\u5141\u8BB8\u590D\u7528\u5DF2\u7EC8\u6001 run\uFF0C\u9ED8\u8BA4 true" }
    ]
  },
  {
    name: "env.runs.list",
    group: "env",
    action: "runs",
    summary: "\u73AF\u5883\u51C6\u5907\u8FD0\u884C\u8BB0\u5F55\u5217\u8868",
    method: "GET",
    path: "/env/runs",
    role: "viewer",
    params: [
      { name: "libraryId", type: "number", description: "\u6309\u4E09\u65B9\u5E93\u8FC7\u6EE4\uFF080=\u4E0D\u9650\uFF09" },
      { name: "limit", type: "number", description: "\u8FD4\u56DE\u6761\u6570\uFF08\u2264100\uFF09\uFF0C\u9ED8\u8BA4 30" }
    ]
  },
  {
    name: "env.runs.get",
    group: "env",
    action: "runs.get",
    summary: "\u5355\u6B21\u73AF\u5883\u51C6\u5907\u8FD0\u884C\u8BE6\u60C5\uFF08\u9010\u6B65\u72B6\u6001/\u5931\u8D25\u5206\u7C7B/\u4EA7\u7269\uFF09",
    method: "GET",
    path: "/env/runs/:id",
    role: "viewer",
    params: []
  },
  {
    name: "env.classify",
    group: "env",
    action: "classify",
    summary: "\u5931\u8D25\u5F52\u7C7B\u8BD5\u7B97\uFF08\u628A\u4E00\u6BB5\u811A\u672C\u8F93\u51FA\u5F52\u6210\u5931\u8D25\u7C7B\u522B\uFF0C\u4E0D\u6267\u884C\u811A\u672C\uFF09",
    method: "POST",
    path: "/env/classify",
    role: "viewer",
    params: [
      { name: "output", type: "string", description: "\u811A\u672C\u6587\u672C\uFF08stderr+stdout\uFF09" },
      { name: "exitCode", type: "number", description: "\u9000\u51FA\u7801", default: 1 },
      { name: "taxonomy", type: "string-array", description: "\u5951\u7EA6\u58F0\u660E\u7684\u5931\u8D25\u5206\u7C7B\uFF08\u9017\u53F7\u5206\u9694\uFF09" }
    ]
  }
];

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
var EXIT_TABLE = [
  { code: EXIT.OK, name: "OK", when: "\u6210\u529F" },
  { code: EXIT.LOCAL_VALIDATION, name: "LOCAL_VALIDATION", when: "\u672C\u5730\u6821\u9A8C\u5931\u8D25\uFF08\u547D\u4EE4\u4E0D\u5B58\u5728/\u53C2\u6570\u7F3A\u5931/\u7EC4\u5408\u975E\u6CD5\uFF09\uFF0C\u8BF7\u6C42\u672A\u53D1\u51FA" },
  { code: EXIT.REJECTED, name: "REJECTED", when: "\u670D\u52A1\u7AEF\u4E1A\u52A1\u62D2\u7EDD\uFF08403 \u6743\u9650\u4E0D\u8DB3 / 404 \u4E0D\u5B58\u5728 / 409 \u5BA1\u6279\u4E2D / 5xx \u670D\u52A1\u7AEF\u9519\u8BEF\uFF09" },
  { code: EXIT.UNAUTHORIZED, name: "UNAUTHORIZED", when: "\u8BA4\u8BC1\u5931\u8D25\uFF08401 \u6216\u4EE4\u724C\u7F3A\u5931/\u65E0\u6548\uFF09" },
  { code: EXIT.TRANSPORT, name: "TRANSPORT", when: "\u4F20\u8F93\u5931\u8D25\uFF08\u7F51\u7EDC\u4E0D\u53EF\u8FBE / \u8D85\u65F6 / \u54CD\u5E94\u975E JSON\uFF09" }
];

// ../agent-tools/src/core/registry.ts
var RANK = { viewer: 1, operator: 2, admin: 3 };
function roleSatisfies(actual, required) {
  return RANK[actual ?? "viewer"] >= RANK[required];
}
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
function toInputSchema(spec) {
  const properties = {};
  const required = [];
  for (const p of pathParams(spec)) {
    const intLike = p === "id" || p.endsWith("Id");
    properties[p] = { type: intLike ? "integer" : "string", description: `\u8DEF\u5F84\u53C2\u6570 ${p}` };
    required.push(p);
  }
  for (const p of spec.params) {
    properties[p.name] = {
      type: p.type === "string-array" ? "array" : p.type === "number" ? "integer" : p.type === "boolean" ? "boolean" : "string",
      description: p.description,
      ...p.enum ? { enum: p.enum } : {},
      ...p.default !== void 0 ? { default: p.default } : {}
    };
    if (p.required) required.push(p.name);
  }
  return { type: "object", properties, required };
}
function toToolDescription(spec) {
  const tags = [`role:${spec.role}`];
  if (spec.dangerous) tags.push("dangerous\uFF08\u9700\u8C03\u7528\u65B9\u786E\u8BA4\uFF09");
  return `${spec.summary}\uFF08${spec.method} ${spec.path}\uFF1B${tags.join(" \xB7 ")}\uFF09`;
}
export {
  COMMANDS,
  allCommands,
  getCommand,
  groups,
  pathParams,
  roleSatisfies,
  toInputSchema,
  toToolDescription
};
