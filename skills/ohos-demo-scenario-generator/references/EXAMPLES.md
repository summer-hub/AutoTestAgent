# 场景生成示例

本文档展示基于 **axios（HTTP 客户端库）** 的 ohos 化版本接口规格文档生成的完整 Demo 测试场景示例。

> 说明：本示例假设已有 axios ohos 化版本的接口规格文档，接口基于 axios 的真实 API 设计。场景内容严格来源于接口规格文档，所有接口签名均为真实存在的接口。

---

## 一、接口规格文档摘要（输入示例）

以下是假设的 axios ohos 化版本接口规格文档关键片段（本技能的输入）：

```markdown
# axios ohos 化版本接口规格

## 核心接口

### axios.get(url, config?)
- 参数：url: string（必填）；config?: AxiosRequestConfig（可选）
- 返回：Promise<AxiosResponse<T>>
- 功能：发起 HTTP GET 请求

### axios.post(url, data?, config?)
- 参数：url: string（必填）；data?: any（请求体）；config?: AxiosRequestConfig（可选）
- 返回：Promise<AxiosResponse<T>>

### axios.create(config?: AxiosRequestConfig): AxiosInstance
- 功能：创建自定义配置的 axios 实例

### axios.interceptors.request.use(onFulfilled?, onRejected?)
- 功能：添加请求拦截器

### axios.interceptors.response.use(onFulfilled?, onRejected?)
- 功能：添加响应拦截器

### CancelToken.source(): CancelTokenSource
- 功能：创建取消令牌，用于取消请求

## AxiosRequestConfig 配置项
- baseURL: string — 基础 URL
- timeout: number — 超时时间（毫秒），0 表示无超时
- headers: Record<string, string> — 请求头
- params: object — URL 查询参数

## AxiosResponse 结构
- data: T — 响应体（已解析）
- status: number — HTTP 状态码
- headers: Record<string, string> — 响应头

## 错误处理
- 网络错误：抛出 AxiosError，code 为 'ERR_NETWORK'
- 超时：抛出 AxiosError，code 为 'ECONNABORTED'
- HTTP 错误（4xx/5xx）：默认抛出 AxiosError，包含 response 对象
```

---

## 二、生成的 Demo 场景示例

以下是本技能基于上述接口规格文档生成的 `axiosDemoScene.md`（注意：实际输出中文件名为 `axiosDemo场景.md`）完整内容示例：

---

```markdown
# axios Demo 测试场景

## 概述

- **库名称**：axios（ohos 化版本）
- **文档生成时间**：2026-03-07
- **基于文档**：axios规格文档.md
- **场景总数**：11（正向 7 个，反向 4 个）
- **功能覆盖模块**：GET/POST 请求、实例创建、请求拦截器、响应拦截器、取消请求、错误处理

## 功能模块映射

| 模块 | 主要接口 | 正向场景 | 反向场景 |
|------|---------|---------|---------|
| GET 请求 | `axios.get()` | S01 | S08 |
| POST 请求 | `axios.post()` | S02 | S09 |
| 自定义实例 | `axios.create()` | S03 | — |
| 请求拦截器 | `interceptors.request.use()` | S04 | S10 |
| 响应拦截器 | `interceptors.response.use()` | S05 | — |
| 取消请求 | `CancelToken.source()` | S06 | S11 |
| 超时配置 | `config.timeout` | S07 | — |

---

## 场景列表

### 正向场景

---

### S01 基础 GET 请求获取数据

**场景类型**：正向

**场景描述**
开发者需要从 REST API 获取用户列表数据。通过调用 `axios.get()` 传入完整 URL，库发起 HTTP GET 请求并返回包含响应体的 `AxiosResponse` 对象。开发者从 `response.data` 中提取用户列表，并在 UI 中展示。

**场景涉及的功能点**
- 发起 GET 请求（对应接口：`axios.get(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>`）
- 读取响应体（对应接口：`AxiosResponse.data: T`）
- 读取 HTTP 状态码（对应接口：`AxiosResponse.status: number`）

**关键体验指标**
- 响应时间：在网络正常情况下，接口调用到 Promise resolve 的时间 < 3000ms
- 数据完整性：`response.data` 与服务端实际返回的 JSON 完全一致
- 状态码准确性：`response.status` 与 HTTP 实际状态码一致

**用户期望**
开发者调用 `axios.get('https://api.example.com/users')` 后，期望 Promise resolve 并返回包含完整用户列表的 `AxiosResponse` 对象，能直接通过 `response.data` 访问解析好的 JSON 数据，无需手动解析。

**场景设计关注点**
- 响应体 JSON 自动解析是否正确（ohos 化实现中 JSON.parse 行为需与标准一致）
- 请求完成后是否存在底层连接未关闭导致的内存泄漏
- OHOS 网络权限（`ohos.permission.INTERNET`）是否已在 module.json5 中声明

---

### S02 POST 请求提交 JSON 数据

**场景类型**：正向

**场景描述**
开发者需要向服务端提交新用户注册信息。通过调用 `axios.post()` 传入 URL 和 JSON 格式的请求体对象，库自动将对象序列化为 JSON 字符串并设置正确的 Content-Type，服务端返回创建成功的用户信息。

**场景涉及的功能点**
- 发起 POST 请求并携带请求体（对应接口：`axios.post(url: string, data?: any, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>`）
- 响应数据读取（对应接口：`AxiosResponse.data: T`）

**关键体验指标**
- 序列化正确性：传入 JS 对象时，请求体序列化为标准 JSON，`Content-Type` 自动设为 `application/json`
- 响应解析：服务端返回 JSON 时，`response.data` 已被自动解析为对象

**用户期望**
开发者传入对象作为 `data` 参数后，期望库自动处理序列化，无需手动调用 `JSON.stringify`；服务端 201 响应的 `response.data` 直接可用，无需手动解析。

**场景设计关注点**
- 传入对象时 Content-Type 是否自动设置为 `application/json`
- 传入 FormData 时 Content-Type 是否自动切换为 `multipart/form-data`
- ohos 化实现中 `@ohos.net.http` 的请求体设置方式是否与标准 axios 行为一致

---

### S03 创建自定义配置的 axios 实例

**场景类型**：正向

**场景描述**
开发者需要在整个应用中统一使用相同的 baseURL 和认证请求头，通过 `axios.create()` 创建自定义实例，所有通过该实例发起的请求都会自动携带预设的配置，避免每次请求都重复配置。

**场景涉及的功能点**
- 创建自定义实例（对应接口：`axios.create(config?: AxiosRequestConfig): AxiosInstance`）
- 实例级 GET 请求（对应接口：`AxiosInstance.get(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>`）
- 设置 baseURL（对应接口：`AxiosRequestConfig.baseURL: string`）
- 设置请求头（对应接口：`AxiosRequestConfig.headers: Record<string, string>`）

**关键体验指标**
- 配置继承：实例发出的请求自动携带 `create()` 时设定的 baseURL 和 headers
- 隔离性：多个实例之间的配置互不干扰
- 实例方法完整性：实例具有与全局 axios 相同的方法（`get`、`post` 等）

**用户期望**
开发者通过 `axios.create({ baseURL: 'https://api.example.com', headers: { 'Authorization': 'Bearer token' } })` 创建实例后，期望所有通过该实例发起的请求都自动携带配置的 baseURL 和认证头，无需每次重复传入。

**场景设计关注点**
- 实例配置与单次请求配置的合并优先级（单次配置应覆盖实例配置）
- `create()` 后修改原始 config 对象是否影响已创建的实例（应不受影响）
- 实例是否支持独立的拦截器（与全局拦截器分离）

---

### S04 请求拦截器添加认证 Token

**场景类型**：正向

**场景描述**
开发者通过请求拦截器在所有出站请求中自动注入最新的认证 Token。拦截器从本地存储读取 Token 并添加到请求头中，确保每次请求都携带有效的认证信息，无需在每个接口调用处手动设置。

**场景涉及的功能点**
- 注册请求拦截器（对应接口：`axios.interceptors.request.use(onFulfilled?: (config: AxiosRequestConfig) => AxiosRequestConfig, onRejected?: (error: any) => any): number`）
- GET 请求（对应接口：`axios.get(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>`）

**关键体验指标**
- 拦截器执行时机：拦截器在请求发出前执行，修改后的 config 被实际使用
- 拦截器调用顺序：多个拦截器按注册顺序依次执行
- 拦截器不影响响应数据：请求拦截器不干扰最终的响应结果

**用户期望**
开发者注册请求拦截器后，期望后续所有请求都自动触发该拦截器，在拦截器中对 `config.headers` 的修改能反映到实际请求中，无需修改已有的业务调用代码。

**场景设计关注点**
- 拦截器中对 config 的修改是否为深拷贝（防止不同请求共享同一个 config 对象）
- 拦截器中抛出异常时是否会导致请求静默失败（应转为 rejected Promise）
- `use()` 返回的 id 能否通过 `eject(id)` 正确移除对应拦截器

---

### S05 响应拦截器统一处理错误响应

**场景类型**：正向

**场景描述**
开发者通过响应拦截器对所有 HTTP 4xx/5xx 响应进行统一的错误处理，包括 401 自动刷新 Token 和 500 的统一错误日志记录。拦截器在响应到达业务代码前统一处理，业务代码只需关注正常数据流。

**场景涉及的功能点**
- 注册响应拦截器（对应接口：`axios.interceptors.response.use(onFulfilled?: (response: AxiosResponse) => AxiosResponse, onRejected?: (error: AxiosError) => any): number`）
- 读取响应状态码（对应接口：`AxiosResponse.status: number`）
- 读取 AxiosError 信息（对应接口：`AxiosError.response?: AxiosResponse`）

**关键体验指标**
- 拦截时机：响应拦截器在 Promise resolve/reject 前执行
- 错误转换：在 onRejected 中 return 正常值可将 rejected 转为 resolved（Promise 链修复）
- 响应数据透传：onFulfilled 返回的值作为最终 Promise 的 resolve 值

**用户期望**
开发者注册响应拦截器后，期望 onRejected 能捕获所有 HTTP 错误，并能通过 `error.response.status` 判断错误类型；在拦截器中 return 新的 Promise 能实现 Token 刷新后的重试。

**场景设计关注点**
- 响应拦截器的 onFulfilled 和 onRejected 返回值类型是否与文档一致
- 拦截器链中某一个拦截器抛出异常时，后续拦截器是否仍然执行
- ohos 化实现中 `@ohos.net.http` 的 HTTP 状态码映射是否完整（包含不常见状态码）

---

### S06 使用 CancelToken 取消进行中的请求

**场景类型**：正向

**场景描述**
开发者在用户离开页面时需要取消正在进行中的网络请求，防止请求结果回来后操作已销毁的组件。通过 `CancelToken.source()` 创建取消令牌，传入请求 config，在 `onPageHide` 时调用 `cancel()` 取消请求。

**场景涉及的功能点**
- 创建取消令牌（对应接口：`CancelToken.source(): { token: CancelToken, cancel: (message?: string) => void }`）
- 发起可取消的请求（对应接口：`AxiosRequestConfig.cancelToken: CancelToken`）
- 取消请求（对应接口：`cancel(message?: string): void`）
- 判断是否为取消错误（对应接口：`axios.isCancel(error: any): boolean`）

**关键体验指标**
- 取消及时性：调用 `cancel()` 后，底层网络连接在 200ms 内关闭
- 错误区分：取消导致的错误通过 `axios.isCancel()` 可被识别，与网络错误区分
- 资源释放：取消后底层 HTTP 请求资源完全释放，不再消耗流量

**用户期望**
开发者调用 `cancel()` 后，期望进行中的请求立即中止，Promise 进入 rejected 状态，且通过 `axios.isCancel(error)` 能判断是主动取消而非网络错误，从而避免在组件已销毁后执行 UI 更新。

**场景设计关注点**
- ohos 化实现中 `@ohos.net.http` 的 `destroy()` 是否能真正中止进行中的请求
- 已经 resolve 的请求不受 `cancel()` 影响（取消只对进行中的请求有效）
- 同一个 token 被多个请求共享时，`cancel()` 是否同时取消所有关联请求

---

### S07 设置超时时间防止请求长时间挂起

**场景类型**：正向

**场景描述**
开发者为接口调用配置 5000ms 超时，确保在服务端无响应时不会无限等待。通过在 `AxiosRequestConfig` 中设置 `timeout: 5000`，超时后 axios 自动中止请求并 reject Promise。

**场景涉及的功能点**
- 配置请求超时（对应接口：`AxiosRequestConfig.timeout: number`）
- 超时错误处理（对应接口：`AxiosError.code: string`，值为 `'ECONNABORTED'`）

**关键体验指标**
- 超时精度：实际超时时间与配置的 `timeout` 误差在 ±200ms 内
- 超时后资源释放：超时触发后，底层网络连接关闭，不再消耗流量
- 错误码正确：超时抛出的 `AxiosError.code` 为 `'ECONNABORTED'`

**用户期望**
开发者配置 `timeout: 5000` 后，期望在 5 秒内未收到响应时，Promise 自动进入 rejected 状态，且 `error.code === 'ECONNABORTED'`，业务代码可据此向用户展示"请求超时，请重试"提示。

**场景设计关注点**
- 超时计时从请求发出时开始还是从建立连接时开始（应与文档说明一致）
- 超时与 `CancelToken.cancel()` 同时触发时，错误类型以哪个为准
- `timeout: 0` 表示不超时，需与未设置 timeout 行为一致

---

### 反向场景

---

### S08 传入无效 URL 发起 GET 请求

**场景类型**：反向

**场景描述**
开发者误将相对路径 `'/api/users'` 作为 URL 传入 `axios.get()` 而未配置 `baseURL`，导致无法构建有效的完整 URL。库应在发出网络请求前检测到 URL 非法，抛出明确的配置错误，而非发出一个必然失败的网络请求。

**场景涉及的功能点**
- GET 请求参数校验（对应接口：`axios.get(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>`）

**关键体验指标**
- 错误提前检测：URL 校验在网络请求发出前完成，避免不必要的网络开销
- 错误信息可读性：抛出的错误消息明确说明 URL 无效，并包含实际传入的值
- 错误类型：抛出 `AxiosError` 或 `TypeError`，类型与文档约定一致

**用户期望**
开发者传入相对路径且未配置 baseURL 时，期望立即收到明确的错误提示（如"Invalid URL: /api/users. Did you forget to set baseURL?"），而不是等待网络超时后才得到一个无意义的网络错误。

**场景设计关注点**
- ohos 化实现中 URL 校验是否在 `@ohos.net.http` 调用前执行
- 传入 `null`、`undefined` 或非字符串类型时的错误提示是否与文档一致
- 空字符串 `''` 的处理是否与 `null` 一致

---

### S09 POST 请求携带过大请求体

**场景类型**：反向

**场景描述**
开发者尝试通过 `axios.post()` 上传一个超过服务端或 OHOS 网络框架限制的大型 JSON 数据（如 100MB 的 Base64 编码文件内容）。库或底层网络框架应抛出明确的大小限制错误，并在错误信息中说明实际大小和限制大小。

**场景涉及的功能点**
- POST 请求发送超大请求体（对应接口：`axios.post(url: string, data?: any, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>`）

**关键体验指标**
- 错误明确性：错误信息包含请求体大小和系统限制大小
- 资源安全：发送过大请求体不导致内存溢出（OOM）
- 错误可捕获：通过 `try/catch` 或 `.catch()` 能正常捕获错误

**用户期望**
开发者传入超大数据时，期望库能优雅地拒绝请求并返回明确的错误（而不是卡死、OOM 崩溃或静默失败），错误信息中包含足够的诊断信息以便开发者调整上传策略（如改用分片上传）。

**场景设计关注点**
- OHOS `@ohos.net.http` 对单次请求体大小是否有硬限制，限制值需与文档一致
- 发送大请求体时的内存占用模式（是否流式发送，或一次性加载到内存）
- 超大请求体被截断发送 vs. 提前报错，哪种行为更符合用户预期

---

### S10 在请求拦截器中抛出异常

**场景类型**：反向

**场景描述**
开发者在请求拦截器的 `onFulfilled` 回调中抛出了一个未预期的异常（如读取本地存储失败）。库应将该异常转换为 Promise 的 rejected 状态，让业务代码通过 `.catch()` 捕获，而不是导致未处理的 Promise rejection 或应用崩溃。

**场景涉及的功能点**
- 请求拦截器异常处理（对应接口：`axios.interceptors.request.use(onFulfilled?, onRejected?): number`）

**关键体验指标**
- 异常转换：拦截器中的抛出异常被转换为 rejected Promise，错误对象被保留
- 稳定性：拦截器异常不影响 axios 实例本身，后续请求仍可正常发起
- 错误可捕获：业务代码可通过 `.catch()` 捕获拦截器中抛出的错误

**用户期望**
开发者在拦截器中无意抛出异常时，期望错误能通过标准 Promise 错误链传递到业务代码的 `.catch()` 中，而不是出现"Unhandled Promise Rejection"警告或导致请求静默失败（既不 resolve 也不 reject）。

**场景设计关注点**
- 拦截器中同步抛出 vs. 返回 `Promise.reject()` 的行为是否一致
- 请求拦截器异常后，响应拦截器的 `onRejected` 是否会被触发
- OHOS ArkTS 环境下未捕获的 Promise rejection 处理机制（与 V8 行为差异）

---

### S11 对已完成的请求调用 cancel()

**场景类型**：反向

**场景描述**
开发者在请求已经成功完成（Promise 已 resolve）后，仍然调用了该请求对应的 `cancel()` 方法（如在组件销毁时统一取消所有已注册的 token）。库对已完成请求的取消操作应安全忽略，不抛出异常，不影响已成功获得的响应数据。

**场景涉及的功能点**
- 取消已完成的请求（对应接口：`cancel(message?: string): void`）
- 判断取消错误（对应接口：`axios.isCancel(error: any): boolean`）

**关键体验指标**
- 安全性：对已完成请求调用 `cancel()` 不抛出异常
- 数据不受影响：已成功 resolve 的响应数据不因后续 `cancel()` 而受到影响
- 幂等性：多次调用 `cancel()` 不产生副作用

**用户期望**
开发者在组件销毁时调用 `cancel()` 时，期望即使请求已完成，调用 `cancel()` 也不会产生任何错误或副作用，已获得的数据保持完整，业务代码无需判断请求是否已完成才能安全调用 `cancel()`。

**场景设计关注点**
- `cancel()` 的幂等性实现（内部状态是否正确追踪请求完成状态）
- ohos 化实现中取消已完成请求时，底层 `@ohos.net.http` 的 `destroy()` 调用是否安全
- 取消未绑定任何请求的 token 时行为（仅绑定后未发出的请求情况）
```

---

## 三、技能调用示例

以下是调用本技能时的标准交互示例：

**用户输入**：
```
请帮我基于 /workspace/axios-ohos/docs/axios规格文档.md 生成 Demo 测试场景
```

**技能执行步骤**：
1. `read_file` 读取 `/workspace/axios-ohos/docs/axios规格文档.md`
2. 提取库名：`axios`，提取功能模块、接口列表、错误码
3. 规划场景：识别 5 个功能模块，规划 7 个正向场景 + 4 个反向场景
4. 逐一生成场景详情（6 要素）
5. `create_file` 创建 `/workspace/axios-ohos/docs/axiosDemo场景.md`

**输出文件**：`/workspace/axios-ohos/docs/axiosDemo场景.md`
