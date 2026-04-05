FROM node:22-alpine

# 빌드 도구 (better-sqlite3 컴파일용)
RUN apk add --no-cache python3 make g++

# Claude CLI 설치
RUN npm install -g @anthropic-ai/claude-code tsx

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

RUN mkdir -p /data/workspaces /data/sessions

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV WORKSPACES_DIR=/data/workspaces
ENV PORT=3001

EXPOSE 3001

# server.ts (socket.io + gramjs + Next.js 통합)
CMD ["tsx", "server.ts"]
