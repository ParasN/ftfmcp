# syntax=docker/dockerfile:1

FROM node:20-bullseye AS builder
WORKDIR /usr/src/app

COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY mcp-server/package.json mcp-server/

RUN npm install
RUN npm install --workspace=backend
RUN npm install --workspace=frontend
RUN npm install --workspace=mcp-server

COPY . .

RUN npm run build

FROM node:20-bullseye AS runner
WORKDIR /usr/src/app

ENV NODE_ENV=production
ENV PORT=8080
ENV MCP_PORT=3002

COPY --from=builder /usr/src/app /usr/src/app

EXPOSE 8080

CMD ["./scripts/start-cloud-run.sh"]
