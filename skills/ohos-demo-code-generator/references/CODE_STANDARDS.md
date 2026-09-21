# Demo 代码生成规范速查

本文档为 `ohos-demo-code-generator` 技能的 ArkTS Demo 代码生成提供规范速查，涵盖命名规则、ArkTS 禁止项、日志规范、权限申请模式等。

---

## 一、文件命名规范

### 目录命名

格式：`{三位序号}_{短英文功能描述}`

| 规则 | 说明 | 示例 |
|------|------|------|
| 三位序号 | 用零补齐，保证目录排序与 Demo 序号一致 | `001`、`012`、`100` |
| 英文描述 | 全小写字母，单词间用下划线，3-5 个单词 | `check_support_and_config` |
| 完整目录名 | `{序号}_{描述}` | `001_check_support_and_config` |

### 组件文件命名

格式：`{PascalCase功能名}Page.ets`

| Demo 中文名 | 目录名 | 文件名 |
|-----------|-------|-------|
| 环境检测与配置创建 Demo | `001_check_support_and_config` | `CheckSupportAndConfigPage.ets` |
| 生命周期管理 Demo | `002_lifecycle_management` | `LifecycleManagementPage.ets` |
| 同步图像处理 Demo | `003_sync_image_process` | `SyncImageProcessPage.ets` |
| 异步网络请求 Demo | `004_async_network_request` | `AsyncNetworkRequestPage.ets` |

### 模型文件命名（可选）

若 Demo 需要数据模型类，在同目录下创建：`{PascalCase名}Model.ets`

---

## 二、ArkTS 编译禁止项（必查）

生成的所有代码必须规避以下 ArkTS 严格模式编译报错：

| 禁止项 | 错误标识 | 正确替代 |
|-------|---------|---------|
| `any` 类型 | `arkts-no-any` | 具体类型或泛型 `T` |
| `Object`/`ESObject` | `arkts-no-esobj` | 定义 `interface` 或具体类型 |
| 动态属性访问 `obj['key']` | `arkts-no-dynamic-property` | `obj.key` 类型安全访问 |
| 内联匿名对象类型 | `arkts-no-obj-literals-as-types` | 定义命名 `interface` |
| `prototype` 扩展 | `arkts-no-prototype-assignment` | 类继承或组合 |
| `delete` 操作符 | `arkts-no-delete` | 设为 `undefined` 或重构对象 |
| `arguments` 对象 | `arkts-no-arguments` | 展开参数 `...args: T[]` |
| 双重 `as unknown as T` | `arkts-no-unsafe-cast` | 正确定义类型，避免强转 |
| `for...in` | `arkts-no-for-in` | `Object.keys().forEach()` |
| `eval()` | `arkts-no-eval` | 禁止使用 |
| `.then().catch()` 链式调用 | 可读性差 | 优先 `async/await + try/catch` |

---

## 三、日志规范

### 3.1 DOMAIN 与 TAG 分配

```typescript
// ✅ 正确：每个页面文件有独立 TAG，DOMAIN 在工程中统一范围
const DOMAIN: number = 0xD001;                     // 单个工程统一使用一个域值
const TAG: string = 'BlurKit_CheckSupportPage';   // {库名}_{页面/模块名}
```

**TAG 命名规则**：`{LibraryName}_{ComponentName}`，不超过 32 字符，只含字母数字下划线。

### 3.2 日志级别选择

| 级别 | 函数 | 使用场景 |
|------|------|---------|
| DEBUG | `hilog.debug(...)` | 方法入口、参数值、中间状态 |
| INFO | `hilog.info(...)` | 操作成功、状态变更、重要里程碑 |
| WARN | `hilog.warn(...)` | 输入非法但可处理、降级处理 |
| ERROR | `hilog.error(...)` | 捕获到异常、接口调用失败 |
| FATAL | `hilog.fatal(...)` | 不可恢复的致命错误（慎用） |

### 3.3 格式化参数

```typescript
// ✅ 公开数据用 %{public}s（会在日志中显示）
hilog.info(DOMAIN, TAG, 'Result count: %{public}d', count);
hilog.info(DOMAIN, TAG, 'File path: %{public}s', filePath);

// ✅ 敏感数据用 %{private}s（日志中显示为 <private>）
hilog.info(DOMAIN, TAG, 'User account: %{private}s', account);
hilog.info(DOMAIN, TAG, 'Token: %{private}s', token);

// ❌ 禁止：将密码、Token、手机号等用 %{public}s 输出
hilog.info(DOMAIN, TAG, 'Password: %{public}s', password); // 安全违规！
```

### 3.4 必须添加日志的位置

| 位置 | 日志级别 | 示例 |
|------|---------|------|
| `aboutToAppear()` | INFO | `hilog.info(..., 'XxxPage appeared')` |
| `aboutToDisappear()` | INFO | `hilog.info(..., 'XxxPage disappeared')` |
| 每个事件处理方法入口 | DEBUG | `hilog.debug(..., 'onButtonClick called')` |
| 接口调用成功 | INFO | `hilog.info(..., 'apiCall succeeded: ...')` |
| 捕获到异常 | ERROR | `hilog.error(..., 'apiCall failed: %{public}s', msg)` |
| 输入校验失败 | WARN | `hilog.warn(..., 'Invalid input: ...')` |

---

## 四、错误处理规范

### 4.1 异步接口标准模式

```typescript
private async callLibraryApi(param: string): Promise<void> {
  hilog.debug(DOMAIN, TAG, 'callLibraryApi called, param: %{public}s', param);
  this.isLoading = true;
  try {
    const result: ReturnType = await libraryApi(param);
    hilog.info(DOMAIN, TAG, 'callLibraryApi succeeded');
    this.resultText = `成功：${String(result)}`;
  } catch (err) {
    // ✅ 正确：使用 (err as Error).message，不使用 any
    const msg: string = (err as Error).message ?? String(err);
    hilog.error(DOMAIN, TAG, 'callLibraryApi failed: %{public}s', msg);
    this.resultText = `错误：${msg}`;
  } finally {
    // ✅ 无论成功失败都要重置 Loading 状态
    this.isLoading = false;
  }
}
```

### 4.2 同步接口标准模式

```typescript
private callSyncApi(): void {
  hilog.debug(DOMAIN, TAG, 'callSyncApi called');
  try {
    const result: ReturnType = syncApi();
    this.resultText = `结果：${String(result)}`;
    hilog.info(DOMAIN, TAG, 'callSyncApi succeeded: %{public}s', String(result));
  } catch (err) {
    const msg: string = (err as Error).message ?? String(err);
    hilog.error(DOMAIN, TAG, 'callSyncApi failed: %{public}s', msg);
    this.resultText = `错误：${msg}`;
  }
}
```

### 4.3 router.pushUrl 错误处理

```typescript
router.pushUrl({ url: 'pages/xxx/XxxPage' }).catch((err: Error) => {
  hilog.error(DOMAIN, TAG, 'Navigation failed: %{public}s', err.message);
});
```

---

## 五、资源生命周期管理

所有持有的资源必须在 `aboutToDisappear()` 中释放，防止内存泄露：

```typescript
// 持有的资源（非状态变量）
private blurManager: BlurManager | null = null;
private timerId: number = -1;
private httpRequest: http.HttpRequest | null = null;

aboutToDisappear(): void {
  hilog.info(DOMAIN, TAG, 'XxxPage disappeared, releasing resources');

  // 释放三方库实例
  if (this.blurManager !== null) {
    this.blurManager.release();
    this.blurManager = null;
  }

  // 清除定时器
  if (this.timerId !== -1) {
    clearInterval(this.timerId);
    this.timerId = -1;
  }

  // 销毁 HTTP 请求
  if (this.httpRequest !== null) {
    this.httpRequest.destroy();
    this.httpRequest = null;
  }
}
```

---

## 六、权限申请规范

### 6.1 常见权限速查

| 功能 | 权限名 | 授权类型 |
|------|-------|---------|
| 网络访问 | `ohos.permission.INTERNET` | 系统自动授权 |
| 读取媒体文件 | `ohos.permission.READ_MEDIA` | 用户授权 |
| 写入媒体文件 | `ohos.permission.WRITE_MEDIA` | 用户授权 |
| 相机 | `ohos.permission.CAMERA` | 用户授权 |
| 麦克风 | `ohos.permission.MICROPHONE` | 用户授权 |
| 位置（精确） | `ohos.permission.LOCATION` | 用户授权 |
| 位置（模糊） | `ohos.permission.APPROXIMATELY_LOCATION` | 用户授权 |
| 蓝牙 | `ohos.permission.USE_BLUETOOTH` | 系统自动授权 |
| 振动 | `ohos.permission.VIBRATE` | 系统自动授权 |

### 6.2 动态权限申请标准模式

```typescript
import abilityAccessCtrl, { Permissions } from '@ohos.abilityAccessCtrl';
import common from '@ohos.app.ability.common';

/**
 * 申请运行时权限
 * @param permissions 需要申请的权限列表
 * @returns 所有权限均已授予返回 true，否则返回 false
 */
private async requestPermissions(permissions: Permissions[]): Promise<boolean> {
  hilog.debug(DOMAIN, TAG, 'requestPermissions called, count: %{public}d', permissions.length);
  const context = getContext(this) as common.UIAbilityContext;
  const atManager = abilityAccessCtrl.createAtManager();
  try {
    const result = await atManager.requestPermissionsFromUser(context, permissions);
    const allGranted: boolean = result.authResults.every((r: number) => r === 0);
    hilog.info(DOMAIN, TAG, 'Permission request result: %{public}s',
               allGranted ? 'all granted' : 'some denied');
    return allGranted;
  } catch (err) {
    const msg: string = (err as Error).message ?? String(err);
    hilog.error(DOMAIN, TAG, 'requestPermissions failed: %{public}s', msg);
    return false;
  }
}
```

---

## 七、UI 组件使用规范

### 7.1 状态显示模板

```typescript
// Loading 状态
if (this.isLoading) {
  LoadingProgress().width(40).height(40).margin({ top: 8 })
}

// 错误/结果文本
if (this.resultText.length > 0) {
  Text(this.resultText)
    .fontSize(14)
    .width('100%')
    .padding(12)
    .backgroundColor(this.isError ? '#FFEBEE' : '#F5F5F5')
    .fontColor(this.isError ? '#C62828' : '#212121')
    .borderRadius(8)
    .margin({ top: 8 })
}
```

### 7.2 按钮禁用逻辑

```typescript
Button('执行操作')
  .width('100%')
  .enabled(!this.isLoading)  // 加载中禁用，防止重复触发
  .onClick(() => this.doAction())
```

### 7.3 列表渲染 key 要求

```typescript
// ✅ ForEach 第三个参数必须提供稳定唯一的 key
ForEach(this.items, (item: ItemType) => {
  ListItem() { /* ... */ }
}, (item: ItemType) => item.id)  // 使用唯一 id 作为 key
```

---

## 八、验证点注释规范

在代码中为 Demo 描述文档中的每条"预期结果"添加验证点注释，帮助开发者对照验证：

```typescript
// ✅ 验证点 1: {第一条预期结果原文}
const result1 = await libraryApi();

// ✅ 验证点 2: {第二条预期结果原文}
this.displayResult = result1;
```

验证点注释应贴近产生该可观测结果的代码行或数据赋值语句。
