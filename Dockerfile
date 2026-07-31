FROM node:18-bookworm-slim AS builder

# better-sqlite3 usually pulls a prebuilt binary, but these let it compile
# from source as a fallback so the build never breaks on an unmatched ABI.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .


FROM node:18-bookworm-slim

WORKDIR /app
COPY --from=builder /app .

ENV NODE_ENV=production
ENV DB_PATH=/app/runtime/orders.sqlite

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||3000)+'/api/orders/menu',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
