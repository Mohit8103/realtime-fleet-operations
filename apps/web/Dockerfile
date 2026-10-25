FROM node:22-alpine

WORKDIR /app

# Install curl for Docker health checks
RUN apk add --no-cache curl

# Copy root manifest and workspaces
COPY package.json package-lock.json* ./
COPY packages/config/package.json ./packages/config/
COPY packages/logger/package.json ./packages/logger/
COPY apps/web/package.json ./apps/web/

# Install dependencies
RUN npm install

# Copy source code
COPY tsconfig.json ./
COPY packages/config ./packages/config
COPY packages/logger ./packages/logger
COPY apps/web ./apps/web

EXPOSE 5173

ENV NODE_ENV=development

CMD ["npm", "run", "dev", "--workspace=@fleet/web", "--", "--host", "0.0.0.0"]
