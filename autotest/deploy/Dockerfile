# AutoTest 独立服务器镜像（A3 · 设计 §13.5）
# 构建上下文 = autotest 仓库根（workspaces：web/shared/dsh-autotest + package-lock.json）：
#   docker build -f deploy/Dockerfile -t autotest-server .
FROM node:20-bookworm-slim AS build
WORKDIR /app

# 先只拷 package*.json 安装依赖，命中分层缓存（源码改动不重装依赖）
COPY package.json package-lock.json ./
COPY web/package.json web/package.json
COPY shared/package.json shared/package.json
COPY dsh-autotest/package.json dsh-autotest/package.json
RUN npm ci

# 再拷源码构建：前端（dsh-autotest/dist/web，含 config.js）+ 服务端（dsh-autotest/lib）
COPY . .
RUN npm run build:standalone

# 裁掉 devDependencies：运行镜像只带生产依赖（better-sqlite3 预编译二进制随安装保留）
RUN npm prune --omit=dev

FROM node:20-bookworm-slim
ENV NODE_ENV=production
ENV AUTOTEST_PORT=3280
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dsh-autotest/package.json ./dsh-autotest/package.json
COPY --from=build /app/dsh-autotest/lib ./dsh-autotest/lib
COPY --from=build /app/dsh-autotest/dist ./dsh-autotest/dist
WORKDIR /app/dsh-autotest
EXPOSE 3280

# 探活用 /healthz（不碰 DB）；slim 镜像没有 curl/wget，用 node 自带 fetch
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.AUTOTEST_PORT||'3280')+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "lib/standalone.js"]
