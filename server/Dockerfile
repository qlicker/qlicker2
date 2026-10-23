FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY src/ ./src/
COPY scripts/repair-question-references.js ./scripts/repair-question-references.js

FROM node:24-alpine
WORKDIR /app
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
RUN addgroup -g 1001 -S appgroup && adduser -S appuser -u 1001
COPY --from=builder /app ./
RUN mkdir -p /app/uploads && chown appuser:appgroup /app/uploads
USER appuser
EXPOSE 3001
CMD ["node", "src/server.js"]
