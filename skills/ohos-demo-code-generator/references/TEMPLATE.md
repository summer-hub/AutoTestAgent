# Demo 代码模板

本文档提供 `ohos-demo-code-generator` 技能生成 Demo 代码时使用的标准模板，包含 Demo 页面模板、主导航页面模板和 module.json5 权限段模板。

---

## 一、Demo 页面模板（无权限版）

适用场景：Demo 不需要任何用户授权权限，仅使用库接口或系统自动授权功能。

```typescript
/**
 * Demo {SEQ}: {ENGLISH_TITLE}
 *
 * 功能说明：{DESCRIPTION}
 * 对应接口：{INTERFACES}
 *
 * @author {AUTHOR}
 */

import hilog from '@ohos.hilog';
import { {ImportedSymbols} } from '{LIBRARY_PACKAGE}';

// ─── 日志常量 ──────────────────────────────────────────────────────────────
const DOMAIN: number = 0xD001;
const TAG: string = '{LIBRARY_TAG}_{PAGE_NAME}';

// ─── 类型定义（根据接口需要填写） ──────────────────────────────────────────
interface {ModelName} {
  // 根据接口返回值类型定义
}

/**
 * {ComponentName} - {中文功能说明}
 *
 * 展示 {LIBRARY_NAME} 的 {核心功能} 使用方法。
 */
@Entry
@Component
struct {ComponentName} {
  // ─── 状态变量 ────────────────────────────────────────────────────────────
  @State private resultText: string = '';
  @State private isLoading: boolean = false;
  @State private isError: boolean = false;

  // ─── 非响应式成员（库实例、Timer 等） ─────────────────────────────────────
  // private instance: {LibraryClass} | null = null;

  // ─── 生命周期 ──────────────────────────────────────────────────────────────

  aboutToAppear(): void {
    hilog.info(DOMAIN, TAG, '{ComponentName} appeared');
  }

  aboutToDisappear(): void {
    hilog.info(DOMAIN, TAG, '{ComponentName} disappeared');
    // TODO: 释放持有的资源（库实例、订阅、Timer 等）
  }

  // ─── 核心功能方法 ─────────────────────────────────────────────────────────

  /**
   * {方法功能说明}
   */
  private async {actionMethod}(): Promise<void> {
    hilog.debug(DOMAIN, TAG, '{actionMethod} called');
    this.isLoading = true;
    this.isError = false;
    try {
      // TODO: 调用三方库接口
      // const result = await {libraryCall};
      // this.resultText = `成功：${String(result)}`;
      hilog.info(DOMAIN, TAG, '{actionMethod} succeeded');
    } catch (err) {
      const msg: string = (err as Error).message ?? String(err);
      hilog.error(DOMAIN, TAG, '{actionMethod} failed: %{public}s', msg);
      this.resultText = `错误：${msg}`;
      this.isError = true;
    } finally {
      this.isLoading = false;
    }
  }

  // ─── UI 构建 ──────────────────────────────────────────────────────────────

  build() {
    Scroll() {
      Column({ space: 16 }) {
        // 页面标题
        Text('[{SEQ}] {中文标题}')
          .fontSize(20)
          .fontWeight(FontWeight.Bold)
          .width('100%')
          .textAlign(TextAlign.Center)
          .padding({ top: 16 })

        Divider()

        // TODO: 根据 Demo 步骤描述填写操作控件（输入框、按钮、选择器等）

        // 执行按钮
        Button('{操作名称}')
          .width('100%')
          .enabled(!this.isLoading)
          .onClick(() => this.{actionMethod}())

        // 加载指示器
        if (this.isLoading) {
          LoadingProgress().width(40).height(40)
        }

        // 结果/错误展示区域
        if (this.resultText.length > 0) {
          Text(this.resultText)
            .fontSize(14)
            .width('100%')
            .padding(12)
            .backgroundColor(this.isError ? '#FFEBEE' : '#F5F5F5')
            .fontColor(this.isError ? '#C62828' : '#212121')
            .borderRadius(8)
        }
      }
      .width('100%')
      .padding(16)
    }
    .width('100%')
    .height('100%')
  }
}
```

---

## 二、Demo 页面模板（含动态权限申请版）

适用场景：Demo 需要申请用户授权权限（如相机、媒体文件访问、位置等）。

```typescript
/**
 * Demo {SEQ}: {ENGLISH_TITLE}
 *
 * 功能说明：{DESCRIPTION}
 * 对应接口：{INTERFACES}
 * 所需权限：{PERMISSIONS}
 *
 * @author {AUTHOR}
 */

import hilog from '@ohos.hilog';
import abilityAccessCtrl, { Permissions } from '@ohos.abilityAccessCtrl';
import common from '@ohos.app.ability.common';
import { {ImportedSymbols} } from '{LIBRARY_PACKAGE}';

// ─── 日志常量 ──────────────────────────────────────────────────────────────
const DOMAIN: number = 0xD001;
const TAG: string = '{LIBRARY_TAG}_{PAGE_NAME}';

// ─── 权限列表（填写此 Demo 实际需要的权限） ────────────────────────────────
const REQUIRED_PERMISSIONS: Permissions[] = [
  'ohos.permission.{PERMISSION_NAME}' as Permissions,
];

@Entry
@Component
struct {ComponentName} {
  @State private resultText: string = '';
  @State private isLoading: boolean = false;
  @State private isError: boolean = false;
  @State private hasPermission: boolean = false;

  aboutToAppear(): void {
    hilog.info(DOMAIN, TAG, '{ComponentName} appeared');
    // 页面加载时主动申请权限
    this.requestNeededPermissions();
  }

  aboutToDisappear(): void {
    hilog.info(DOMAIN, TAG, '{ComponentName} disappeared');
    // 释放持有资源
  }

  // ─── 权限申请 ─────────────────────────────────────────────────────────────

  /**
   * 申请 Demo 所需的运行时权限。
   * 须在使用权限保护接口前调用。
   */
  private async requestNeededPermissions(): Promise<void> {
    hilog.debug(DOMAIN, TAG, 'requestNeededPermissions called');
    const context = getContext(this) as common.UIAbilityContext;
    const atManager = abilityAccessCtrl.createAtManager();
    try {
      const result = await atManager.requestPermissionsFromUser(context, REQUIRED_PERMISSIONS);
      this.hasPermission = result.authResults.every((r: number) => r === 0);
      hilog.info(DOMAIN, TAG, 'Permission result: %{public}s',
                 this.hasPermission ? 'granted' : 'denied');
      if (!this.hasPermission) {
        this.resultText = '提示：需要授予权限才能运行此 Demo';
        this.isError = true;
      }
    } catch (err) {
      const msg: string = (err as Error).message ?? String(err);
      hilog.error(DOMAIN, TAG, 'requestNeededPermissions failed: %{public}s', msg);
      this.resultText = `权限申请失败：${msg}`;
      this.isError = true;
    }
  }

  // ─── 核心功能方法 ─────────────────────────────────────────────────────────

  private async {actionMethod}(): Promise<void> {
    if (!this.hasPermission) {
      hilog.warn(DOMAIN, TAG, '{actionMethod} skipped: permission not granted');
      this.resultText = '请先授予所需权限';
      return;
    }
    hilog.debug(DOMAIN, TAG, '{actionMethod} called');
    this.isLoading = true;
    this.isError = false;
    try {
      // TODO: 调用需要权限的接口
      hilog.info(DOMAIN, TAG, '{actionMethod} succeeded');
    } catch (err) {
      const msg: string = (err as Error).message ?? String(err);
      hilog.error(DOMAIN, TAG, '{actionMethod} failed: %{public}s', msg);
      this.resultText = `错误：${msg}`;
      this.isError = true;
    } finally {
      this.isLoading = false;
    }
  }

  build() {
    Scroll() {
      Column({ space: 16 }) {
        Text('[{SEQ}] {中文标题}')
          .fontSize(20)
          .fontWeight(FontWeight.Bold)
          .width('100%')
          .textAlign(TextAlign.Center)
          .padding({ top: 16 })

        Divider()

        // 权限状态提示
        if (!this.hasPermission) {
          Text('⚠️ 权限未授予，部分功能不可用')
            .fontSize(13)
            .fontColor('#E65100')
            .width('100%')
            .padding(8)
            .backgroundColor('#FFF3E0')
            .borderRadius(6)
        }

        // TODO: 操作控件

        Button('{操作名称}')
          .width('100%')
          .enabled(!this.isLoading && this.hasPermission)
          .onClick(() => this.{actionMethod}())

        if (this.isLoading) {
          LoadingProgress().width(40).height(40)
        }

        if (this.resultText.length > 0) {
          Text(this.resultText)
            .fontSize(14)
            .width('100%')
            .padding(12)
            .backgroundColor(this.isError ? '#FFEBEE' : '#F5F5F5')
            .fontColor(this.isError ? '#C62828' : '#212121')
            .borderRadius(8)
        }
      }
      .width('100%')
      .padding(16)
    }
    .width('100%')
    .height('100%')
  }
}
```

---

## 三、主导航页面模板（DemoIndex.ets）

```typescript
/**
 * {LIBRARY_NAME} Demo 主导航页面
 *
 * 汇总所有测试 Demo 的入口，通过 List 展示 Demo 列表并支持点击跳转。
 *
 * @author {AUTHOR}
 */

import hilog from '@ohos.hilog';
import router from '@ohos.router';

const DOMAIN: number = 0xD001;
const TAG: string = '{LIBRARY_TAG}_DemoIndex';

/** Demo 条目数据结构（禁止使用 Object/any） */
interface DemoEntry {
  id: string;          // 三位序号字符串：'001'、'002'
  title: string;       // Demo 中文名称
  description: string; // 一句话功能描述
  route: string;       // router.pushUrl 目标路径
}

/**
 * DEMO_LIST - 所有 Demo 的配置信息。
 * 每新增一个 Demo 必须在此列表中追加一条记录。
 */
const DEMO_LIST: DemoEntry[] = [
  // TODO: 按 Demo 描述文档中的序号顺序填写
  {
    id: '001',
    title: '{Demo 1 中文名}',
    description: '{Demo 1 一句话描述}',
    route: 'pages/001_{dir_name}/{ComponentName}'
  },
  {
    id: '002',
    title: '{Demo 2 中文名}',
    description: '{Demo 2 一句话描述}',
    route: 'pages/002_{dir_name}/{ComponentName}'
  },
  // ... 其他 Demo
];

@Entry
@Component
struct DemoIndex {
  aboutToAppear(): void {
    hilog.info(DOMAIN, TAG, 'DemoIndex appeared, demo count: %{public}d', DEMO_LIST.length);
  }

  build() {
    Column() {
      // 页面标题区域
      Text('{LIBRARY_NAME} Demo 示例')
        .fontSize(22)
        .fontWeight(FontWeight.Bold)
        .width('100%')
        .textAlign(TextAlign.Center)
        .padding({ top: 24, bottom: 4 })

      Text(`共 ${DEMO_LIST.length} 个测试 Demo`)
        .fontSize(13)
        .fontColor('#888888')
        .width('100%')
        .textAlign(TextAlign.Center)
        .margin({ bottom: 16 })

      // Demo 列表
      List({ space: 8 }) {
        ForEach(DEMO_LIST, (demo: DemoEntry) => {
          ListItem() {
            this.DemoCard(demo)
          }
        }, (demo: DemoEntry) => demo.id)
      }
      .width('100%')
      .layoutWeight(1)
      .padding({ left: 16, right: 16, bottom: 16 })
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#F0F2F5')
  }

  @Builder
  DemoCard(demo: DemoEntry): void {
    Row({ space: 12 }) {
      // 序号圆形标签
      Text(demo.id)
        .fontSize(13)
        .fontWeight(FontWeight.Bold)
        .fontColor(Color.White)
        .width(40)
        .height(40)
        .textAlign(TextAlign.Center)
        .backgroundColor('#1976D2')
        .borderRadius(20)

      // 标题和描述
      Column({ space: 4 }) {
        Text(demo.title)
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .fontColor('#212121')
        Text(demo.description)
          .fontSize(12)
          .fontColor('#888888')
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .padding(12)
    .backgroundColor(Color.White)
    .borderRadius(10)
    .onClick(() => {
      hilog.info(DOMAIN, TAG, 'Navigate to demo %{public}s', demo.id);
      router.pushUrl({ url: demo.route }).catch((err: Error) => {
        hilog.error(DOMAIN, TAG, 'Navigate to %{public}s failed: %{public}s',
                    demo.id, err.message);
      });
    })
  }
}
```

---

## 四、main_pages.json 路由配置模板

```json
{
  "src": [
    "pages/DemoIndex",
    "pages/001_{dir1}/{Component1}",
    "pages/002_{dir2}/{Component2}"
  ]
}
```

**更新规则**：
- 主页面 `DemoIndex` 必须列在第一位
- 其余 Demo 页面按序号顺序排列
- `route` 字段与 Demo 页面的 `@Entry` 组件所在路径一致（不含 `.ets` 后缀）

---

## 五、module.json5 权限声明模板

在 `module.json5` 的 `"module"` 节点下添加 `"requestPermissions"` 字段：

```json5
{
  "module": {
    // ...其他字段...
    "requestPermissions": [
      {
        // 网络权限（系统自动授权，无需 usedScene）
        "name": "ohos.permission.INTERNET"
      },
      {
        // 读取媒体文件（需用户授权）
        "name": "ohos.permission.READ_MEDIA",
        "reason": "$string:permission_read_media_reason",
        "usedScene": {
          "abilities": ["EntryAbility"],
          "when": "inuse"
        }
      },
      {
        // 相机（需用户授权）
        "name": "ohos.permission.CAMERA",
        "reason": "$string:permission_camera_reason",
        "usedScene": {
          "abilities": ["EntryAbility"],
          "when": "inuse"
        }
      }
    ]
  }
}
```

> ⚠️ `reason` 字段必须引用 `$string:xxx` 资源，不得硬编码字符串。需在 `resources/base/element/string.json` 中添加对应字符串资源。
