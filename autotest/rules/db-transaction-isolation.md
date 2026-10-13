---
id: db-transaction-isolation
title: 数据库事务纪律（SQLite 单连接并发）
description: 改 db/ 或写库路径前必读：事务隔离、嵌套语义、缓存失效时序
tags: ["db", "transaction", "isolation", "sqlite", "mysql"]
priority: 92
load_bearing: true
inject_when:
  paths: ["dsh-autotest/src/db/**", "dsh-autotest/src/services/**"]
  touches: ["db", "transaction", "isolation", "sqlite", "mysql", "cache"]
timestamp: 2026-10-13T00:00:00Z
---

# 数据库事务纪律

## SQLite（better-sqlite3，单连接 + 同步执行）

- 事务打开期间，别的并发请求发来的语句会落在同一条连接上，被卷进本事务——
  **事务隔离被击穿**。`connection.ts` 用异步互斥锁把事务串行化：事务进行中，
  非事务语句排队等待；只有事务自身（AsyncLocalStorage 标记）可直接执行；
- **嵌套事务并入外层**（内层不单独提交/回滚）：SQLite 自我死锁与 MySQL
  连接池耗尽都由此避免；
- 写路径的缓存失效必须在**写库成功之后**调用：写在写库之前时，并发读会把旧值
  重新回填进缓存，造成 TTL 内的脏读。

## MySQL（连接池）

- 事务从池取连接，`beginTransaction` → `txStore.run(conn, fn)` → `commit`；
  `rollback` 必须在 catch 里，`release` 在 finally；
- `LIMIT` 类参数必须同时给上下限：SQLite 的 `LIMIT -1` 表示无限制（整表返回），
  MySQL 下同一请求直接语法错误。

## 参数

- 支持位置 `?` 与命名 `@name`（内部转换）；单个对象参数触发命名参数转换。
