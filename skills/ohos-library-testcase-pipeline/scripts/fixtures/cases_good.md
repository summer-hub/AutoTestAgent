# json-schema 测试用例（自检样例 · 好用例）

| 编号 | 接口 | 场景 | 优先级 | 前置 | 步骤 | 预期 | 判据 | 可测性 | 证据/关联 |
|---|---|---|---|---|---|---|---|---|---|
| C-AI-001 | Validator.validate | 正向 | P0 | 已进入「简单校验」页 | 打开应用<br>点击「校验」<br>验证「校验通过」 | 界面出现「校验通过」 | control_text: 界面出现「校验通过」 | A | demo 调用点 pages/SimpleValidatePage:30 |
| C-AI-002 | Validator.validate | 空值 | P1 | 已进入「简单校验」页 | 打开应用<br>输入「」到「数据输入框」<br>点击「校验」<br>验证「数据不能为空」 | 界面出现「数据不能为空」 | control_text: 界面出现「数据不能为空」 | A | 同上 |
| C-AI-003 | Validator.validate | 边界异常 | P1 | 已进入「简单校验」页 | 打开应用<br>点击「校验超大值」<br>验证「数值超出范围」 | 界面出现「数值超出范围」 | control_text: 界面出现「数值超出范围」<br>no_crash: 执行期间无崩溃 | C | demo 改造：PagingPage.ets 新增「校验超大值」按钮 buildItems(10000)；devecocli build 通过；真机截图 3 张 |
| C-AI-004 | SchemaError.message | 空值 | P2 | 已触发一次校验失败 | 打开应用<br>点击「校验」<br>验证「格式错误」 | 日志出现错误码 | hilog_keyword: 关键字 jsonschema | A | demo 调用点 pages/SimpleValidatePage:30 |
| C-AI-005 | Validator.validate | 正向 | P1 | 已进入「简单校验」页 | 打开应用<br>点击「提交」<br>验证「操作成功」 | 界面出现「操作成功」 | control_text: 界面出现「操作成功」 | A | 界面上真实存在的文案，含"成功"二字但**不是**含糊值，不应误判 |
