---
name: ohos-demo-code-generator
description: 基于 Demo 描述说明文档（通常由 ohos-arkts-demo-doc-generator 生成）自动生成可在鸿蒙（HarmonyOS）系统上编译运行的 ArkTS 测试 Demo 实现代码。每个 Demo 独立 ETS 页面文件，命名格式为"序号+简短英文功能描述"，通过主页面统一导航。生成代码严格遵循华为 ArkTS 编码规范，包含 hilog 日志、错误处理、必要注释和权限适配。当用户需要将 Demo 描述文档转化为可运行的鸿蒙 Demo 工程代码时使用此技能。
license: Apache-2.0
compatibility: 需要 HarmonyOS DevEco Studio 开发环境、鸿蒙 SDK（API Level ≥ 11）、hvigorw 构建工具。HarmonyOS API 查询依赖 knowledge-base MCP 服务（https://8.152.217.126/mcp）。建议在 macOS 或 Linux 环境中使用。
metadata:
  author: lalhan
  version: "1.0.0"
  category: harmonyos-development
  language: ArkTS/ETS
---

# 鸿蒙 ArkTS 测试 Demo 代码生成技能

本技能读取三方库 Demo 描述说明文档，为每个 Demo 生成独立的 ArkTS 页面实现代码，并生成统一的主页面导航代码，确保所有代码能够在鸿蒙系统上编译运行，正确展示三方库的功能和使用方法。

> ⚠️ **核心约束**：所有生成的代码必须基于 Demo 描述文档中真实存在的接口和功能，严禁凭空捏造不存在的接口、参数或行为。所有代码须通过 ArkTS 严格模式编译检查。
>
> 📐 **编码规范（强制）**：严格遵循 [华为 ArkTS 编程规范](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/arkts-coding-style-guide)：PascalCase 类名、camelCase 方法/变量、2 空格缩进、行尾分号、禁止 `any`/`ESObject`。
>
> 🔢 **Demo 数量约束（强制）**：生成的 Demo 页面数量**必须**与描述文档中的 Demo 条目数量完全一致，**严禁**以任何理由减少、合并或跳过 Demo。若描述文档列出 N 个 Demo，则必须生成 N 个独立的页面文件，缺少任意一个均视为任务未完成。
>
> 🏷️ **文件命名约束（强制）**：每个 Demo 页面的 ETS 文件名**必须**以描述文档中的三位补零序号开头，格式为 `{序号}_{PascalCase描述}Page.ets`，例如文档序号 1 对应 `001_FrameGrabPage.ets`，序号 10 对应 `010_PictureMetaPage.ets`。**严禁**生成不带序号前缀的页面文件。路由注册（`main_pages.json`）和导航代码（`Index.ets`）中的路径也必须使用带序号前缀的完整文件名。

---

## 适用场景

- 将 `ohos-arkts-demo-doc-generator` 生成的 Demo 描述文档转化为可运行代码
- 为已移植鸿蒙三方库快速生成功能验证 Demo 工程
- 生成符合华为规范的三方库示例代码用于文档展示或 QA 测试

---

## 输入要求

| 参数 | 必需 | 说明 |
|------|------|------|
| Demo 描述文档路径 | ✅ | `*测试demo描述.md` 文件，包含 Demo 名称、步骤、预期结果、对应接口 |
| 鸿蒙工程路径 | ✅ | 目标鸿蒙工程根目录（已编译通过，含 `entry/` 和 `library/` 模块） |
| 三方库包名 | 条件必需 | 若工程中有多个库模块，需指定目标库包名（如 `@ohos/blur-kit`） |

---

## 工作流程

### 阶段零：准备工作

#### 0.1 解析 Demo 描述文档

```
1. read_file 读取 Demo 描述文档全文
2. 提取文档中的库名称（用于代码中的 TAG 等标识符）
3. 解析"测试 Demo 描述列表"表格，提取每行的：
   - 序号（整数）
   - 测试 Demo 名称（中文）
   - 测试 Demo 描述
   - 测试 Demo 步骤
   - 测试 Demo 预期结果
   - 对应函数接口（签名列表）
4. 解析"接口覆盖矩阵"，了解每个接口所属 Demo
5. 统计 Demo 总数，规划生成文件列表
```

#### 0.2 探查鸿蒙工程结构

```
1. list_dir 列出工程根目录，识别 entry/、library/ 等模块
2. 读取 entry/src/main/ets/ 目录结构，了解现有页面组织方式
3. 读取 entry/src/main/resources/base/profile/main_pages.json，了解路由配置
4. 读取 library/index.ets（或 library/src/main/ets/index.ets），获取库导出接口
5. 读取 entry/src/main/module.json5，查看已声明权限
6. 读取一个现有页面 ETS 文件，了解工程的代码风格和导入惯例
```

#### 0.3 生成文件规划

根据解析结果，建立文件规划表：

```
文件规划（内部工作记录）：
┌──────────────────────────────────────────────────────────────────────┐
│ 主页面：entry/src/main/ets/pages/DemoIndex.ets                        │
│                                                                      │
│ Demo 页面列表（按序号）：                                              │
│   001_check_support/           → Demo 1：环境检测                     │
│     CheckSupportPage.ets                                             │
│   002_blur_manager_lifecycle/  → Demo 2：BlurManager 生命周期          │
│     BlurManagerLifecyclePage.ets                                     │
│   003_sync_blur_image/         → Demo 3：同步图像模糊                  │
│     SyncBlurImagePage.ets                                            │
│   ...                                                                │
└──────────────────────────────────────────────────────────────────────┘
```

---

### 阶段一：生成各 Demo 页面代码

对每个 Demo，按以下步骤生成对应的 ArkTS 页面文件。

#### 1.1 推导 Demo 文件命名

**命名规则**：`{序号(三位补零)}_{短英文功能描述}` 作为目录名，页面组件文件名采用 PascalCase 加 `Page` 后缀。

示例映射：
| 序号 | 中文 Demo 名称 | 目录名 | 页面文件名 |
|------|--------------|--------|-----------|
| 1 | 环境检测与配置创建 Demo | `001_check_support_and_config` | `CheckSupportAndConfigPage.ets` |
| 2 | BlurManager 生命周期管理 Demo | `002_blur_manager_lifecycle` | `BlurManagerLifecyclePage.ets` |
| 3 | 同步图像模糊处理 Demo | `003_sync_blur_image` | `SyncBlurImagePage.ets` |
| 4 | 异步图像模糊处理 Demo | `004_async_blur_image` | `AsyncBlurImagePage.ets` |

关键规则：
- 序号必须三位数字（`001`、`010`、`100`），保证目录排序与 Demo 顺序一致
- 英文描述使用小写字母和下划线，体现该 Demo 的核心功能
- 每个目录单独存放一个 `.ets` 页面文件，若需要模型类可同目录添加 `{name}Model.ets`
- **⚠️ 强制**：描述文档中有多少个 Demo 条目，就必须生成多少个页面文件，数量严格对应，不可减少
- **⚠️ 强制**：ETS 文件名必须以序号前缀开头（如 `001_FrameGrabPage.ets`），`main_pages.json` 路由路径和 `Index.ets` 中的 `router.pushUrl` URL 均须使用带完整序号前缀的名称

#### 1.2 分析接口权限需求

在生成代码前，检查 Demo 使用到的接口，识别需要权限的功能：

```
权限查询方式：
1. 使用 knowledge-base MCP 的 harmonyos_doc_search 查询接口权限需求
   参数：{ keywords: ["<接口名>", "权限"], maxCharSize: 4000 }
2. 对照权限清单，记录需要的权限（如 ohos.permission.INTERNET、
   ohos.permission.READ_MEDIA 等）
3. 分类为：
   - 系统权限（module.json5 声明即可自动授权）
   - 用户授权权限（需运行时 requestPermissionsFromUser 动态申请）
```

#### 1.3 生成 Demo 页面 ETS 代码

每个 Demo 页面文件的结构规范：

```typescript
/**
 * Demo {序号}: {英文功能描述}
 * 
 * 功能说明：{从 Demo 描述文档提取的描述}
 * 对应接口：{涉及的函数签名列表}
 * 
 * @author lalhan
 */

import hilog from '@ohos.hilog';
// 按需导入其他模块（权限、媒体、文件等）

import { LibraryClass, libraryFunc } from '{库包名}';

// ─── 日志常量（禁止在此以外的地方直接使用魔法字符串） ───────────────────────
const DOMAIN: number = 0xD001;   // 与工程其他模块保持统一域值范围
const TAG: string = '{LibraryName}_{ComponentName}';

// ─── 页面状态类型定义（禁止使用 any/Object/ESObject） ────────────────────────
interface DemoState {
  // 页面中需要响应式更新的状态字段（具体类型）
}

/**
 * {ComponentName} - {Demo 功能说明}
 *
 * 展示 {库名} 的 {核心功能} 使用方法。
 */
@Entry
@Component
struct {ComponentName} {
  // ─── 状态变量（@State 响应式）──────────────────────────────────────────────
  @State private resultText: string = '';
  @State private isLoading: boolean = false;
  // ...其他状态

  // ─── 非响应式成员 ──────────────────────────────────────────────────────────
  // （库实例、定时器 ID 等）

  // ─── 生命周期 ──────────────────────────────────────────────────────────────

  aboutToAppear(): void {
    hilog.info(DOMAIN, TAG, 'Demo page appeared');
    // 初始化逻辑（如权限检查、资源加载）
  }

  aboutToDisappear(): void {
    hilog.info(DOMAIN, TAG, 'Demo page disappeared');
    // 必须在此处释放持有的资源（库实例、订阅、Timer 等）
  }

  // ─── 核心功能方法 ──────────────────────────────────────────────────────────

  /**
   * {方法说明}
   * {参数说明}
   */
  private async {actionMethod}(): Promise<void> {
    hilog.debug(DOMAIN, TAG, '{actionMethod} called');
    this.isLoading = true;
    try {
      // 调用三方库接口
      const result = await {libraryCall};
      hilog.info(DOMAIN, TAG, '{actionMethod} succeeded: %{public}s', String(result));
      this.resultText = `结果：${String(result)}`;
    } catch (err) {
      const msg: string = (err as Error).message ?? String(err);
      hilog.error(DOMAIN, TAG, '{actionMethod} failed: %{public}s', msg);
      this.resultText = `错误：${msg}`;
    } finally {
      this.isLoading = false;
    }
  }

  // ─── UI 构建 ──────────────────────────────────────────────────────────────

  build() {
    Column({ space: 16 }) {
      // 页面标题
      Text('{Demo 标题}')
        .fontSize(20)
        .fontWeight(FontWeight.Bold)
        .width('100%')
        .textAlign(TextAlign.Center)
        .padding({ top: 16 })

      // 操作控件区域
      // ...根据 Demo 步骤描述生成具体 UI

      // 结果展示区域
      if (this.isLoading) {
        LoadingProgress().width(40).height(40)
      } else {
        Text(this.resultText)
          .fontSize(14)
          .width('100%')
          .padding(12)
          .backgroundColor('#F5F5F5')
          .borderRadius(8)
      }
    }
    .width('100%')
    .height('100%')
    .padding(16)
  }
}
```

**代码生成质量要求（逐条强制检查）**：

| 要求 | 检查标准 |
|------|---------|
| 日志覆盖 | 每个公共方法/事件回调入口必须有 `hilog.debug`，关键成功节点有 `hilog.info`，捕获异常有 `hilog.error` |
| 错误处理 | 所有异步调用必须用 `try/catch` 包裹，同步调用失败须在 UI 上显示错误信息 |
| 资源释放 | `aboutToDisappear` 中释放库实例、取消订阅、清理 Timer |
| 类型安全 | 禁止 `any`、`ESObject`、`Object`，所有变量须声明具体类型 |
| 权限申请 | 需要用户授权的权限必须在使用前动态申请，使用 `abilityAccessCtrl.requestPermissionsFromUser` |
| 注释完整性 | 组件级 JSDoc + 每个核心方法 JSDoc + 关键逻辑行内注释 |
| UI 完整性 | 页面包含标题、操作按钮/控件、状态指示（Loading/Error）、结果展示区域 |

#### 1.4 调用 ohos-library-feature-adder 辅助生成复杂代码

对于涉及复杂接口调用（如媒体处理、传感器、蓝牙等）的 Demo，使用 `ohos-library-feature-adder` 技能辅助生成：

```
触发条件（满足任一项）：
- Demo 涉及 PixelMap、AVPlayer、Camera 等重型系统 API
- Demo 需要实现复杂的异步状态机
- Demo 涉及 C/C++ NDK 接口调用

调用方式：
  向 ohos-library-feature-adder 提供：
  1. 鸿蒙工程路径
  2. 功能描述（从 Demo 描述文档提取的步骤和接口）
  3. 生成后需按本技能规范（命名、日志、注释）进行二次校验和修改
```

---

### 阶段二：生成主页面导航代码

#### 2.1 主页面结构

生成 `DemoIndex.ets`（或在现有主页面中添加导航入口），实现对所有 Demo 页面的跳转：

```typescript
/**
 * {LibraryName} Demo 主导航页面
 *
 * 提供所有 Demo 的入口列表，通过 router.pushUrl 跳转到各 Demo 页面。
 */

import hilog from '@ohos.hilog';
import router from '@ohos.router';

const DOMAIN: number = 0xD001;
const TAG: string = '{LibraryName}_DemoIndex';

// Demo 条目数据结构
interface DemoEntry {
  id: string;        // Demo 编号，如 "001"
  title: string;     // Demo 中文名称
  description: string; // Demo 简要描述
  route: string;     // 路由路径
}

// Demo 列表配置（按序号排列）
const DEMO_LIST: DemoEntry[] = [
  {
    id: '001',
    title: '{Demo 1 名称}',
    description: '{Demo 1 描述（一句话）}',
    route: 'pages/001_xxx/{ComponentName}'
  },
  // ... 其他 Demo
];

@Entry
@Component
struct DemoIndex {
  build() {
    Column() {
      Text('{LibraryName} Demo 示例')
        .fontSize(22)
        .fontWeight(FontWeight.Bold)
        .padding({ top: 20, bottom: 20 })

      List({ space: 8 }) {
        ForEach(DEMO_LIST, (demo: DemoEntry) => {
          ListItem() {
            this.DemoCard(demo)
          }
        }, (demo: DemoEntry) => demo.id)
      }
      .width('100%')
      .layoutWeight(1)
    }
    .width('100%')
    .height('100%')
    .padding({ left: 16, right: 16 })
  }

  @Builder
  DemoCard(demo: DemoEntry): void {
    Row() {
      Column({ space: 4 }) {
        Text(`[${demo.id}] ${demo.title}`)
          .fontSize(16)
          .fontWeight(FontWeight.Medium)
        Text(demo.description)
          .fontSize(13)
          .fontColor('#666666')
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      Image($r('app.media.ic_arrow_right'))
        .width(20)
        .height(20)
    }
    .width('100%')
    .padding(12)
    .backgroundColor(Color.White)
    .borderRadius(8)
    .onClick(() => {
      hilog.info(DOMAIN, TAG, 'Navigate to demo: %{public}s', demo.id);
      router.pushUrl({ url: demo.route }).catch((err: Error) => {
        hilog.error(DOMAIN, TAG, 'Navigation failed: %{public}s', err.message);
      });
    })
  }
}
```

#### 2.2 更新路由配置

在 `entry/src/main/resources/base/profile/main_pages.json` 中添加所有新 Demo 页面的路由：

```json
{
  "src": [
    "pages/DemoIndex",
    "pages/001_xxx/CheckSupportPage",
    "pages/002_xxx/BlurManagerLifecyclePage"
  ]
}
```

---

### 阶段三：权限与系统能力适配

#### 3.1 更新 module.json5 权限声明

将各 Demo 所需权限汇总，更新 `module.json5`：

```json5
{
  "module": {
    "requestPermissions": [
      {
        "name": "ohos.permission.INTERNET",
        "reason": "$string:permission_internet_reason",
        "usedScene": {
          "abilities": ["EntryAbility"],
          "when": "inuse"
        }
      }
      // ... 其他权限
    ]
  }
}
```

#### 3.2 动态权限申请模板

对于需要用户授权的权限，在 Demo 页面的 `aboutToAppear` 中添加：

```typescript
import abilityAccessCtrl, { Permissions } from '@ohos.abilityAccessCtrl';
import common from '@ohos.app.ability.common';

private async requestNeededPermissions(): Promise<boolean> {
  const permissions: Permissions[] = ['ohos.permission.READ_MEDIA'];
  const context = getContext(this) as common.UIAbilityContext;
  const atManager = abilityAccessCtrl.createAtManager();
  
  try {
    const result = await atManager.requestPermissionsFromUser(context, permissions);
    const allGranted = result.authResults.every(r => r === 0);
    hilog.info(DOMAIN, TAG, 'Permission request result: %{public}s', 
               allGranted ? 'granted' : 'denied');
    return allGranted;
  } catch (err) {
    hilog.error(DOMAIN, TAG, 'Permission request failed: %{public}s', (err as Error).message);
    return false;
  }
}
```

---

### 阶段四：代码质量检查与修正

生成所有文件后，执行以下检查：

#### 4.1 ArkTS 语法检查（自动）

```
如果工程使用 hvigorw，运行编译检查：
  cd {工程路径} && ./hvigorw assembleHap --no-daemon 2>&1 | grep -E "error|warning"

如果存在编译错误：
  1. 逐条读取错误信息
  2. 对照 references/CODE_STANDARDS.md 中的禁止项速查
  3. 修正对应文件中的错误代码
  4. 重新运行编译验证
```

#### 4.2 代码规范自查清单

| 检查项 | 标准 | 状态 |
|-------|------|------|
| 文件命名规范 | `{三位序号}_{英文描述}` 目录 + PascalCase+Page 组件文件 | □ |
| 日志 DOMAIN/TAG 正确 | 每个文件有独立 TAG，DOMAIN 在工程范围内统一 | □ |
| 每个方法有 hilog.debug 入口日志 | 无遗漏 | □ |
| 异步调用有 try/catch | 无裸 await | □ |
| 资源在 aboutToDisappear 释放 | 无资源泄露 | □ |
| 无 any/ESObject/Object 类型 | 全量类型安全 | □ |
| 需要权限的接口有权限申请逻辑 | 无缺失 | □ |
| 主页面 DEMO_LIST 包含全部 Demo | 与描述文档数量一致 | □ |
| main_pages.json 路由已更新 | 所有新页面已注册 | □ |

#### 4.3 功能验证点

针对 Demo 描述文档中的"预期结果"，在代码中添加注释标记，方便开发者在设备上验证：

```typescript
// ✅ 验证点 1: {从 Demo 预期结果提取的可观测指标}
// ✅ 验证点 2: {下一条预期结果}
```

---

### 阶段五：输出汇总

生成完成后，向用户输出以下信息：

```markdown
## 代码生成完成

### 生成文件列表

| 文件路径 | 说明 |
|---------|------|
| entry/src/main/ets/pages/DemoIndex.ets | 主导航页面 |
| entry/src/main/ets/pages/001_xxx/XxxPage.ets | Demo 1：{名称} |
| ... | ... |

### 路由配置更新
已更新 `main_pages.json`，新增 N 个路由。

### 权限变更
已在 `module.json5` 中新增以下权限声明：
- `ohos.permission.XXX`：{用途说明}

### 编译验证
{编译结果：通过 / 存在警告（已修复）}

### 验证步骤
1. 在 DevEco Studio 中打开工程，运行到鸿蒙设备
2. 进入主导航页，点击 [001] {Demo 1 名称} 进行验证
3. 按各 Demo 页面内的"验证点"注释检查功能是否正常
```

---

## 参考资料

- 代码规范与禁止项速查：[references/CODE_STANDARDS.md](references/CODE_STANDARDS.md)
- 页面代码模板：[references/TEMPLATE.md](references/TEMPLATE.md)
- 生成示例对比：[references/EXAMPLES.md](references/EXAMPLES.md)
