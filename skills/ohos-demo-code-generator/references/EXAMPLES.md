# 示例：ohos-blur-kit Demo 代码生成

本文档展示使用 `ohos-demo-code-generator` 技能，基于 `ohos-blur-kit` 库的测试 Demo 描述文档，生成实际 ArkTS 页面代码的完整示例。

---

## 输入：Demo 描述文档片段（来自 ohos-arkts-demo-doc-generator）

| 序号 | 测试 Demo 名称 | 对应函数接口 |
|-----|--------------|------------|
| 1 | 环境检测与配置创建 Demo | `isSupported(): boolean`、`createBlurConfig(radius, mode): BlurConfig` |
| 2 | BlurManager 生命周期管理 Demo | `new BlurManager(radius)`、`setRadius()`、`getRadius()`、`release()` |

---

## 输出示例一：Demo 01 页面代码

**文件路径**：`entry/src/main/ets/pages/001_check_support_and_config/CheckSupportAndConfigPage.ets`

```typescript
/**
 * Demo 001: Check Support And Config
 *
 * 功能说明：展示如何在使用 BlurManager 前检测当前设备是否支持模糊能力，
 *           以及如何通过 createBlurConfig() 创建合法的模糊配置对象。
 * 对应接口：isSupported(): boolean
 *           createBlurConfig(radius: number, mode: BlurMode): BlurConfig
 *
 * @author lalhan
 */

import hilog from '@ohos.hilog';
import { isSupported, createBlurConfig, BlurMode, BlurConfig } from '@ohos/blur-kit';

// ─── 日志常量 ──────────────────────────────────────────────────────────────
const DOMAIN: number = 0xD001;
const TAG: string = 'BlurKit_CheckSupportPage';

// ─── 类型定义 ──────────────────────────────────────────────────────────────

/** 模糊模式选项，与 UI 选择器绑定 */
interface BlurModeOption {
  label: string;
  value: BlurMode;
}

const BLUR_MODE_OPTIONS: BlurModeOption[] = [
  { label: 'Gaussian', value: BlurMode.GAUSSIAN },
  { label: 'Stack',    value: BlurMode.STACK },
  { label: 'Box',      value: BlurMode.BOX },
];

/**
 * CheckSupportAndConfigPage - 环境检测与配置创建示例
 *
 * 展示 ohos-blur-kit 的设备能力检测和配置对象创建流程。
 */
@Entry
@Component
struct CheckSupportAndConfigPage {
  // ─── 状态变量 ────────────────────────────────────────────────────────────
  @State private supportStatus: string = '未检测';
  @State private isSupported: boolean = false;
  @State private selectedMode: BlurMode = BlurMode.GAUSSIAN;
  @State private radiusInputVal: string = '15';
  @State private configResult: string = '';
  @State private isCheckLoading: boolean = false;
  @State private isConfigLoading: boolean = false;

  aboutToAppear(): void {
    hilog.info(DOMAIN, TAG, 'CheckSupportAndConfigPage appeared');
  }

  aboutToDisappear(): void {
    hilog.info(DOMAIN, TAG, 'CheckSupportAndConfigPage disappeared');
  }

  // ─── 核心功能方法 ─────────────────────────────────────────────────────────

  /**
   * 检测当前设备是否支持模糊功能。
   * 调用 isSupported() 并将结果显示在页面上。
   */
  private async checkDeviceSupport(): Promise<void> {
    hilog.debug(DOMAIN, TAG, 'checkDeviceSupport called');
    this.isCheckLoading = true;
    try {
      // ✅ 验证点 1: isSupported() 返回布尔值，页面显示支持/不支持状态
      const supported: boolean = isSupported();
      this.isSupported = supported;
      this.supportStatus = supported ? '当前设备支持模糊 ✅' : '当前设备不支持模糊 ❌';
      hilog.info(DOMAIN, TAG, 'Device blur support: %{public}s', String(supported));
    } catch (err) {
      const msg: string = (err as Error).message ?? String(err);
      hilog.error(DOMAIN, TAG, 'checkDeviceSupport failed: %{public}s', msg);
      this.supportStatus = `检测失败：${msg}`;
    } finally {
      this.isCheckLoading = false;
    }
  }

  /**
   * 根据当前选择的 BlurMode 和输入的 radius 创建 BlurConfig 对象。
   * 调用 createBlurConfig(radius, mode) 并将结果 JSON 展示在页面上。
   */
  private async createConfig(): Promise<void> {
    hilog.debug(DOMAIN, TAG, 'createConfig called, mode: %{public}s, radius: %{public}s',
                this.selectedMode, this.radiusInputVal);
    this.isConfigLoading = true;
    try {
      const radius: number = Number(this.radiusInputVal);
      if (isNaN(radius) || radius <= 0) {
        this.configResult = '错误：radius 必须为正数';
        hilog.warn(DOMAIN, TAG, 'Invalid radius input: %{public}s', this.radiusInputVal);
        return;
      }

      // ✅ 验证点 2: createBlurConfig() 返回 BlurConfig 对象，页面格式化展示
      const config: BlurConfig = createBlurConfig(radius, this.selectedMode);
      this.configResult = JSON.stringify({
        radius: config.radius,
        mode: config.mode,
        quality: config.quality ?? '(默认)'
      }, null, 2);
      hilog.info(DOMAIN, TAG, 'BlurConfig created successfully, radius: %{public}d, mode: %{public}s',
                 config.radius, config.mode);
    } catch (err) {
      const msg: string = (err as Error).message ?? String(err);
      hilog.error(DOMAIN, TAG, 'createConfig failed: %{public}s', msg);
      this.configResult = `错误：${msg}`;
    } finally {
      this.isConfigLoading = false;
    }
  }

  // ─── UI 构建 ──────────────────────────────────────────────────────────────

  build() {
    Scroll() {
      Column({ space: 16 }) {
        // 页面标题
        Text('[001] 环境检测与配置创建')
          .fontSize(20)
          .fontWeight(FontWeight.Bold)
          .width('100%')
          .textAlign(TextAlign.Center)
          .padding({ top: 16 })

        Divider()

        // ── 区块一：设备支持检测 ──────────────────────────────
        Text('1. 设备支持检测').fontSize(16).fontWeight(FontWeight.Medium)

        Text(this.supportStatus)
          .fontSize(14)
          .fontColor(this.isSupported ? '#2E7D32' : '#C62828')
          .padding(8)

        Button('检测设备支持')
          .width('100%')
          .onClick(() => this.checkDeviceSupport())
          .enabled(!this.isCheckLoading)

        if (this.isCheckLoading) {
          LoadingProgress().width(32).height(32)
        }

        Divider()

        // ── 区块二：创建模糊配置 ──────────────────────────────
        Text('2. 创建模糊配置').fontSize(16).fontWeight(FontWeight.Medium)

        // Radius 输入框
        Row({ space: 8 }) {
          Text('Radius:').fontSize(14).width(60)
          TextInput({ placeholder: '输入模糊半径（>0）', text: this.radiusInputVal })
            .type(InputType.Number)
            .layoutWeight(1)
            .onChange((val: string) => { this.radiusInputVal = val; })
        }.width('100%')

        // BlurMode 选择
        Row({ space: 8 }) {
          Text('Mode:').fontSize(14).width(60)
          Select(BLUR_MODE_OPTIONS.map(o => ({ value: o.label })))
            .selected(0)
            .onSelect((idx: number) => {
              this.selectedMode = BLUR_MODE_OPTIONS[idx].value;
              hilog.debug(DOMAIN, TAG, 'BlurMode selected: %{public}s', BLUR_MODE_OPTIONS[idx].label);
            })
            .layoutWeight(1)
        }.width('100%')

        Button('创建 BlurConfig')
          .width('100%')
          .onClick(() => this.createConfig())
          .enabled(!this.isConfigLoading)

        if (this.isConfigLoading) {
          LoadingProgress().width(32).height(32)
        }

        // 结果展示
        if (this.configResult.length > 0) {
          Text('BlurConfig 对象：')
            .fontSize(14)
            .fontWeight(FontWeight.Medium)
          Text(this.configResult)
            .fontSize(13)
            .fontFamily('monospace')
            .width('100%')
            .padding(12)
            .backgroundColor('#F5F5F5')
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

## 输出示例二：主导航页面代码

**文件路径**：`entry/src/main/ets/pages/DemoIndex.ets`

```typescript
/**
 * ohos-blur-kit Demo 主导航页面
 *
 * 提供所有 Demo 的入口列表，通过 router.pushUrl 跳转到各 Demo 页面。
 */

import hilog from '@ohos.hilog';
import router from '@ohos.router';

const DOMAIN: number = 0xD001;
const TAG: string = 'BlurKit_DemoIndex';

interface DemoEntry {
  id: string;
  title: string;
  description: string;
  route: string;
}

const DEMO_LIST: DemoEntry[] = [
  {
    id: '001',
    title: '环境检测与配置创建',
    description: '检测设备是否支持模糊能力，创建 BlurConfig 配置对象',
    route: 'pages/001_check_support_and_config/CheckSupportAndConfigPage'
  },
  {
    id: '002',
    title: 'BlurManager 生命周期管理',
    description: '展示 BlurManager 的创建、radius 读写和资源释放流程',
    route: 'pages/002_blur_manager_lifecycle/BlurManagerLifecyclePage'
  },
  {
    id: '003',
    title: '同步图像模糊处理',
    description: '使用 blurSync() 对 PixelMap 进行同步模糊处理并展示结果',
    route: 'pages/003_sync_blur_image/SyncBlurImagePage'
  },
  {
    id: '004',
    title: '异步图像模糊处理',
    description: '使用 blur() 对 PixelMap 进行异步模糊处理，展示 Promise 使用方式',
    route: 'pages/004_async_blur_image/AsyncBlurImagePage'
  },
];

@Entry
@Component
struct DemoIndex {
  aboutToAppear(): void {
    hilog.info(DOMAIN, TAG, 'DemoIndex appeared, total demos: %{public}d', DEMO_LIST.length);
  }

  build() {
    Column() {
      Text('ohos-blur-kit Demo 示例')
        .fontSize(22)
        .fontWeight(FontWeight.Bold)
        .width('100%')
        .textAlign(TextAlign.Center)
        .padding({ top: 24, bottom: 8 })

      Text(`共 ${DEMO_LIST.length} 个 Demo`)
        .fontSize(14)
        .fontColor('#666666')
        .width('100%')
        .textAlign(TextAlign.Center)
        .margin({ bottom: 16 })

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
      // 序号标签
      Text(demo.id)
        .fontSize(14)
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
      hilog.info(DOMAIN, TAG, 'Navigate to demo %{public}s: %{public}s', demo.id, demo.route);
      router.pushUrl({ url: demo.route }).catch((err: Error) => {
        hilog.error(DOMAIN, TAG, 'Navigation to %{public}s failed: %{public}s',
                    demo.id, err.message);
      });
    })
  }
}
```

---

## 对应的 main_pages.json 更新

```json
{
  "src": [
    "pages/DemoIndex",
    "pages/001_check_support_and_config/CheckSupportAndConfigPage",
    "pages/002_blur_manager_lifecycle/BlurManagerLifecyclePage",
    "pages/003_sync_blur_image/SyncBlurImagePage",
    "pages/004_async_blur_image/AsyncBlurImagePage"
  ]
}
```
