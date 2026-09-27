# syntax=docker/dockerfile:1
# 海岸遗址航拍覆盖认证：静态前端 + 一次性验证服务

# ---- 依赖层 ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---- verify：一次性服务（代码测试 + 前端构建 + 冒烟，以退出码报告结果） ----
FROM deps AS verify
COPY . .
CMD ["node", "scripts/verify.mjs"]

# ---- 前端构建 ----
FROM deps AS build
COPY . .
RUN npm run build

# ---- web：静态前端（nginx，含健康检查） ----
FROM nginx:1.27-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
EXPOSE 80
