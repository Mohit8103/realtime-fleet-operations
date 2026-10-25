FROM node:22-alpine

WORKDIR /app

# Install curl for Docker health checks
RUN apk add --no-cache curl

# Copy root manifest and workspaces
COPY package.json package-lock.json* ./
COPY packages/config/package.json ./packages/config/
COPY packages/logger/package.json ./packages/logger/
COPY apps/api/package.json ./apps/api/

# Install dependencies
RUN npm install

# Copy source code
COPY tsconfig.json ./
COPY packages/config ./packages/config
COPY packages/logger ./packages/logger
COPY apps/api ./apps/api

EXPOSE 3000

ENV NODE_ENV=production
ENV API_PORT=3000
ENV API_HOST=0.0.0.0

CMD ["npx", "tsx", "apps/api/src/index.ts"]
