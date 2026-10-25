FROM node:22-alpine

WORKDIR /app

# Install curl for Docker health checks
RUN apk add --no-cache curl

# Copy root manifest and workspaces
COPY package.json package-lock.json* ./
COPY packages/config/package.json ./packages/config/
COPY packages/logger/package.json ./packages/logger/
COPY apps/worker/package.json ./apps/worker/

# Install dependencies
RUN npm install

# Copy source code
COPY tsconfig.json ./
COPY packages/config ./packages/config
COPY packages/logger ./packages/logger
COPY apps/worker ./apps/worker

EXPOSE 3001

ENV NODE_ENV=production
ENV WORKER_HEALTH_PORT=3001

CMD ["npx", "tsx", "apps/worker/src/index.ts"]
