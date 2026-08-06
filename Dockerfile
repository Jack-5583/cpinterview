FROM node:20-alpine
WORKDIR /app

# 의존성 먼저 설치 (레이어 캐시)
COPY package*.json ./
RUN npm ci --omit=dev

# 앱 소스
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
# 데이터 저장 위치(퍼시스턴트 디스크를 붙일 경우 이 경로로 마운트)
ENV DATA_DIR=/app/data

EXPOSE 3000
CMD ["node", "server.js"]
