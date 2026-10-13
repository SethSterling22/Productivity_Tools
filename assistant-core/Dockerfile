FROM node:20-alpine

# Non-root user for the service
RUN addgroup -g 1002 assistant && adduser -u 1002 -G assistant -s /bin/sh -D assistant

WORKDIR /app
COPY package.json ./
# --omit=optional skips ssh2's native cpu-features build (not needed; pure-JS crypto
# fallback works) so the image builds on alpine without python/make/g++.
RUN npm install --omit=dev --omit=optional

COPY src ./src
COPY migrations ./migrations
COPY public ./public
COPY tools.manifest.json ./tools.manifest.json

USER assistant

ENV NODE_ENV=production
ENV PORT=8090
EXPOSE 8090

CMD ["node", "src/index.js"]
