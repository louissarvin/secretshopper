# Bun runs the TypeScript directly; 1.4.4+ is required by @nearai/inference-sdk's TLS binding (tester).
FROM oven/bun:1.4.4-slim AS build
WORKDIR /app
COPY package.json bun.lockb* bun.lock* ./
# full install: the local prisma 7 CLI is a devDependency (bunx would otherwise fetch npm latest, an 8.x rc)
RUN bun install --frozen-lockfile
COPY prisma ./prisma
# generate needs a syntactically valid URL only; no DB connection is made
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build bunx prisma generate --config prisma/prisma.config.ts

FROM oven/bun:1.4.4-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json bun.lockb* bun.lock* ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/prisma ./prisma
COPY tsconfig.json index.ts tester.ts dotenv.ts ./
COPY src ./src
# committed measurements served by GET /public/model-runs and /public/verify-report
COPY data ./data
USER bun
ENV APP_HOST=0.0.0.0
EXPOSE 3700
# API by default; run the tester as a separate container: bun tester.ts (env from .env.tester)
CMD ["bun", "index.ts"]
