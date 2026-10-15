# A self-hosted OpenVibe.Actor (docs/self-host.md): one process, PGlite in /data unless DATABASE_URL is set.
#   npm run selfhost:init -- --name you --url http://localhost:4950   (writes .env.selfhost)
#   docker compose -f docker-compose.selfhost.yml up -d
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server ./server
COPY public ./public
COPY migrations ./migrations
COPY scripts ./scripts
COPY STATUS.json ./
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4950 DATA_DIR=/data ACTOR_SELF_HOSTED=1
VOLUME /data
EXPOSE 4950
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:4950/api/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/index.js"]
