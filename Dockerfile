# 演示环境镜像：单进程 + SQLite 文件，无第三方依赖
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4399 \
    DB_FILE=/app/data/app.db

# 应用代码（无 node_modules）
COPY package.json ./
COPY server.js api.js db.js ./
COPY lib ./lib
COPY public ./public

# 数据目录：挂在卷上，否则重建容器会重置演示数据
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 4399
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4399)+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
