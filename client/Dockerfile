FROM node:24-alpine AS builder
WORKDIR /app
ARG APP_VERSION=dev
ENV VITE_APP_VERSION=$APP_VERSION
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
ARG APP_VERSION=dev
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/templates/default.conf.template
ENV API_PORT=3001
ENV APP_VERSION=$APP_VERSION
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
