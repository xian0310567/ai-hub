FROM node:22-alpine

WORKDIR /app

# 의존성 설치
COPY package.json ./
RUN npm install --production

# 소스 복사 및 빌드
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

EXPOSE 4000
CMD ["node", "dist/index.js"]
