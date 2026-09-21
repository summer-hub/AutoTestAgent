# 覆盖率分析示例

本文档基于 axios（HTTP 客户端库）提供完整的 Demo 场景覆盖率分析示例，展示输入、分析过程和输出格式。

---

## 一、输入示例

### 1.1 Demo 场景文档（输入）

假设 `axiosDemo场景.md` 包含以下场景：

| 场景编号 | 场景名称 | 类型 | 涉及接口 |
|---------|---------|------|---------|
| S01 | 基础 GET 请求获取数据 | 正向 | `axios.get()` |
| S02 | POST 请求提交 JSON 数据 | 正向 | `axios.post()` |
| S03 | 创建自定义配置的 axios 实例 | 正向 | `axios.create()`, `AxiosInstance.get()` |
| S04 | 请求拦截器添加与验证 | 正向 | `axios.interceptors.request.use()` |
| S05 | 响应拦截器添加与验证 | 正向 | `axios.interceptors.response.use()` |
| S06 | 请求取消功能验证 | 正向 | `CancelToken.source()`, `cancel()` |
| S07 | 设置超时时间防止请求挂起 | 正向 | `AxiosRequestConfig.timeout` |
| S08 | 传入无效 URL 发起 GET 请求 | 反向 | `axios.get()` |
| S09 | POST 请求携带过大请求体 | 反向 | `axios.post()` |
| S10 | 在请求拦截器中抛出异常 | 反向 | `axios.interceptors.request.use()` |
| S11 | 对已完成的请求调用 cancel() | 反向 | `cancel()`, `axios.isCancel()` |

### 1.2 Demo 代码（输入）

假设 entry 目录下有以下 Demo 文件：

**Index.ets** — 基础请求 Demo
```typescript
import axios from '@ohos/axios';
import { AxiosResponse, AxiosError } from '@ohos/axios';

@Entry
@Component
struct Index {
  @State result: string = '';
  @State error: string = '';

  build() {
    Column() {
      Button('GET 请求').onClick(() => {
        axios.get('https://api.example.com/users')
          .then((res: AxiosResponse) => { this.result = JSON.stringify(res.data); })
          .catch((err: AxiosError) => { this.error = err.message; });
      })

      Button('POST 请求').onClick(() => {
        axios.post('https://api.example.com/users', { name: 'test' })
          .then((res: AxiosResponse) => { this.result = JSON.stringify(res.data); })
          .catch((err: AxiosError) => { this.error = err.message; });
      })

      Text('结果: ' + this.result)
      Text('错误: ' + this.error)
    }
  }
}
```

**CustomInstanceDemo.ets** — 自定义实例 Demo
```typescript
import axios from '@ohos/axios';

@Entry
@Component
struct CustomInstanceDemo {
  @State result: string = '';

  build() {
    Column() {
      Button('创建实例并发送请求').onClick(() => {
        const instance = axios.create({ baseURL: 'https://api.example.com' });
        instance.get('/users')
          .then((res) => { this.result = JSON.stringify(res.data); })
          .catch((err) => { this.result = 'Error: ' + err.message; });
      })

      Text('结果: ' + this.result)
    }
  }
}
```

**CancelDemo.ets** — 取消请求 Demo
```typescript
import axios, { CancelToken } from '@ohos/axios';

@Entry
@Component
struct CancelDemo {
  @State result: string = '';

  build() {
    Column() {
      Button('发起可取消请求').onClick(() => {
        const source = CancelToken.source();
        axios.get('https://api.example.com/users', { cancelToken: source.token })
          .then((res) => { this.result = '完成'; })
          .catch((err) => {
            if (axios.isCancel(err)) { this.result = '请求已取消'; }
            else { this.result = '错误: ' + err.message; }
          });

        // 1秒后自动取消
        setTimeout(() => { source.cancel('用户取消'); }, 1000);
      })

      Text('结果: ' + this.result)
    }
  }
}
```

---

## 二、分析过程

### 2.1 场景与代码匹配

| 场景 | 覆盖状态 | 判定依据 |
|------|---------|---------|
| S01 | ✅ 完全覆盖 | Index.ets 中有 `axios.get()` 调用，有结果展示和错误处理 |
| S02 | ✅ 完全覆盖 | Index.ets 中有 `axios.post()` 调用，有结果展示和错误处理 |
| S03 | 🔶 部分覆盖 | CustomInstanceDemo.ets 中有 `axios.create()` 和 `instance.get()`，但未设置自定义 headers |
| S04 | ❌ 未覆盖 | 无文件调用 `axios.interceptors.request.use()` |
| S05 | ❌ 未覆盖 | 无文件调用 `axios.interceptors.response.use()` |
| S06 | ✅ 完全覆盖 | CancelDemo.ets 中有 `CancelToken.source()`、`cancel()`、`axios.isCancel()` |
| S07 | ❌ 未覆盖 | 无代码设置 `AxiosRequestConfig.timeout` |
| S08 | 🔶 部分覆盖 | Index.ets 中有 `axios.get()` 的 catch 处理，但无法主动传入无效 URL |
| S09 | ❌ 未覆盖 | 无"过大请求体"触发逻辑 |
| S10 | ❌ 未覆盖 | 无拦截器抛出异常的逻辑 |
| S11 | 🔶 部分覆盖 | CancelDemo.ets 中有 cancel 逻辑，但无法验证"对已完成请求调用 cancel"的场景 |

### 2.2 覆盖率计算

- 场景总数：11（正向 7 个，反向 4 个）
- ✅ 完全覆盖：3 个（S01, S02, S06）
- 🔶 部分覆盖：3 个（S03, S08, S11）
- ❌ 未覆盖：5 个（S04, S05, S07, S09, S10）
- 整体覆盖率：(3×1.0 + 3×0.5 + 5×0) / 11 = 4.5 / 11 = 40.9%

---

## 三、输出示例

生成的 `axiosDemo场景覆盖率报告.md` 如下（截取关键部分）：

---

# axios Demo 场景覆盖率分析报告

## 概述

- **库名称**：axios
- **报告生成时间**：2025-06-01
- **基于场景文档**：axiosDemo场景.md
- **分析代码范围**：entry/src/main/ets/
- **场景总数**：11（正向 7 个，反向 4 个）
- **覆盖统计**：
  - ✅ 完全覆盖：3 个（27%）
  - 🔶 部分覆盖：3 个（27%）
  - ❌ 未覆盖：5 个（46%）
- **整体覆盖率**：40.9%

## 场景覆盖详情

### 正向场景覆盖

| 场景编号 | 场景名称 | 覆盖状态 | 接口覆盖率 | 匹配文件 | 差距说明 |
|---------|---------|---------|-----------|---------|---------|
| S01 | 基础 GET 请求获取数据 | ✅ | 1/1 (100%) | Index.ets | — |
| S02 | POST 请求提交 JSON 数据 | ✅ | 1/1 (100%) | Index.ets | — |
| S03 | 创建自定义配置的 axios 实例 | 🔶 | 2/3 (67%) | CustomInstanceDemo.ets | 缺少 headers 配置接口 |
| S04 | 请求拦截器添加与验证 | ❌ | 0/1 (0%) | — | 无拦截器代码 |
| S05 | 响应拦截器添加与验证 | ❌ | 0/1 (0%) | — | 无拦截器代码 |
| S06 | 请求取消功能验证 | ✅ | 3/3 (100%) | CancelDemo.ets | — |
| S07 | 设置超时时间防止请求挂起 | ❌ | 0/1 (0%) | — | 无 timeout 配置 |

### 反向场景覆盖

| 场景编号 | 场景名称 | 覆盖状态 | 接口覆盖率 | 匹配文件 | 差距说明 |
|---------|---------|---------|-----------|---------|---------|
| S08 | 传入无效 URL 发起 GET 请求 | 🔶 | 1/1 (100%) | Index.ets | 接口已覆盖但无法主动触发无效 URL |
| S09 | POST 请求携带过大请求体 | ❌ | 0/1 (0%) | — | 无过大请求体触发逻辑 |
| S10 | 在请求拦截器中抛出异常 | ❌ | 0/1 (0%) | — | 无拦截器代码 |
| S11 | 对已完成的请求调用 cancel() | 🔶 | 2/2 (100%) | CancelDemo.ets | cancel 接口已覆盖但无法验证"已完成请求"场景 |

## 未覆盖场景详细分析

### 🔶 部分覆盖场景

#### S03 创建自定义配置的 axios 实例
- **已覆盖部分**：`axios.create()` 创建实例、`instance.get()` 发送请求、`baseURL` 配置
- **未覆盖部分**：`AxiosRequestConfig.headers` 自定义请求头配置未在 Demo 中展示
- **补充建议**：在 CustomInstanceDemo.ets 中添加 headers 配置输入框，允许用户设置自定义请求头，并在请求结果中展示 headers 是否生效
- **补充优先级**：🟡 中
- **预估工作量**：S

#### S08 传入无效 URL 发起 GET 请求
- **已覆盖部分**：`axios.get()` 的错误处理（catch 回调）
- **未覆盖部分**：无法主动传入无效 URL 触发错误场景
- **补充建议**：在 Index.ets 中添加 URL 输入框，允许用户手动输入 URL（包括无效 URL），从而验证无效 URL 的错误处理
- **补充优先级**：🟡 中
- **预估工作量**：S

#### S11 对已完成的请求调用 cancel()
- **已覆盖部分**：`cancel()` 调用和 `axios.isCancel()` 判断
- **未覆盖部分**：无法验证"对已完成请求调用 cancel()"的特殊行为
- **补充建议**：在 CancelDemo.ets 中添加"先等待请求完成再取消"按钮，延迟 3 秒后调用 cancel()，验证对已完成请求的行为
- **补充优先级**：🟢 低
- **预估工作量**：S

### ❌ 未覆盖场景

#### S04 请求拦截器添加与验证
- **未覆盖原因**：所有 Demo 文件均未使用拦截器 API
- **补充建议**：新增 InterceptorDemo.ets 页面，实现请求拦截器添加按钮，在拦截器中修改请求配置（如添加 token），展示拦截前后的请求配置对比
- **补充优先级**：🔴 高
- **预估工作量**：M

#### S05 响应拦截器添加与验证
- **未覆盖原因**：所有 Demo 文件均未使用响应拦截器 API
- **补充建议**：与 S04 合并到同一 InterceptorDemo.ets 页面，实现响应拦截器添加按钮，在拦截器中处理响应数据，展示拦截前后的响应数据对比
- **补充优先级**：🔴 高
- **预估工作量**：M

#### S07 设置超时时间防止请求挂起
- **未覆盖原因**：所有 Demo 请求均未设置 timeout 配置
- **补充建议**：在 Index.ets 或新增 TimeoutDemo.ets 中添加超时时间输入框和慢速 API 地址，设置 `{ timeout: 3000 }` 配置，验证超时后的错误处理
- **补充优先级**：🔴 高
- **预估工作量**：S

#### S09 POST 请求携带过大请求体
- **未覆盖原因**：无触发过大请求体的交互逻辑
- **补充建议**：在 Index.ets 的 POST 请求部分添加"发送大请求体"按钮，构造超大数据对象发送，验证服务端或库的拒绝处理
- **补充优先级**：🟢 低
- **预估工作量**：S

#### S10 在请求拦截器中抛出异常
- **未覆盖原因**：无拦截器代码
- **补充建议**：与 S04 合并到 InterceptorDemo.ets，添加"拦截器抛异常"按钮，在请求拦截器中主动 throw Error，验证异常传播和处理
- **补充优先级**：🟡 中
- **预估工作量**：S

## 功能模块覆盖统计

| 功能模块 | 场景总数 | ✅ 完全覆盖 | 🔶 部分覆盖 | ❌ 未覆盖 | 模块覆盖率 |
|---------|---------|-----------|-----------|---------|-----------|
| 请求发送 | 3 | 2 | 1 | 0 | 83% |
| 实例创建 | 1 | 0 | 1 | 0 | 50% |
| 拦截器 | 3 | 0 | 0 | 3 | 0% |
| 取消请求 | 2 | 1 | 1 | 0 | 75% |
| 超时处理 | 1 | 0 | 0 | 1 | 0% |
| 异常处理 | 2 | 0 | 1 | 1 | 25% |

## Demo 代码文件清单

| 文件路径 | 覆盖场景 | 主要实现功能 |
|---------|---------|------------|
| entry/src/main/ets/pages/Index.ets | S01, S02, S08 | 基础 GET/POST 请求及错误处理 |
| entry/src/main/ets/pages/CustomInstanceDemo.ets | S03 | 自定义实例创建与请求 |
| entry/src/main/ets/pages/CancelDemo.ets | S06, S11 | 请求取消功能 |

## 补充开发优先级建议

### 🔴 高优先级（核心功能缺失）
1. **S04 请求拦截器添加与验证** — 拦截器是 axios 核心功能，且 S05、S10 均依赖此能力
   - 建议：新增 InterceptorDemo.ets，实现请求/响应拦截器

2. **S05 响应拦截器添加与验证** — 与 S04 可合并实现
   - 建议：在 InterceptorDemo.ets 中同时实现

3. **S07 设置超时时间防止请求挂起** — 超时是常用的健壮性保障机制
   - 建议：新增 TimeoutDemo.ets 或在 Index.ets 中添加超时配置

### 🟡 中优先级（功能不完整）
1. **S03 创建自定义配置的 axios 实例** — 实例已创建但缺少 headers 配置展示
   - 建议：在 CustomInstanceDemo.ets 中添加 headers 配置输入

2. **S08 传入无效 URL 发起 GET 请求** — 错误处理已有但无法主动触发
   - 建议：在 Index.ets 中添加 URL 输入框

3. **S10 在请求拦截器中抛出异常** — 依赖 S04 拦截器实现
   - 建议：在 InterceptorDemo.ets 中添加异常抛出按钮

### 🟢 低优先级（增强体验）
1. **S09 POST 请求携带过大请求体** — 罕见异常场景
   - 建议：在 Index.ets 中添加大请求体发送按钮

2. **S11 对已完成的请求调用 cancel()** — 取消功能已有，此为边界验证
   - 建议：在 CancelDemo.ets 中添加延迟取消按钮

---

## 四、技能调用示例

```text
用户指令：
分析 /path/to/axiosDemo场景.md 与 /path/to/ohos-axios/entry/src/main/ets/ 的覆盖率

执行：
1. 读取 Demo 场景文档 → 提取 11 个场景
2. 扫描 entry 目录 → 发现 3 个 Demo 文件
3. 逐场景匹配 → 3 完全覆盖 / 3 部分覆盖 / 5 未覆盖
4. 生成 axiosDemo场景覆盖率报告.md
```
