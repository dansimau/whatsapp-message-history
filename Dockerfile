FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    WMH_DATA_DIR=/data \
    WMH_HOST=0.0.0.0 \
    WMH_PORT=8765
# e2fsprogs provides chattr/lsattr for the btrfs copy-on-write guard.
RUN apt-get update && apt-get install -y --no-install-recommends e2fsprogs && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
VOLUME ["/data"]
EXPOSE 8765
ENTRYPOINT ["node", "dist/index.js"]
CMD ["serve"]
