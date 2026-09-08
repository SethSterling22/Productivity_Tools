FROM node:20-alpine

# Non-root user for the service
RUN addgroup -g 1002 assistant && adduser -u 1002 -G assistant -s /bin/sh -D assistant

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY migrations ./migrations
COPY public ./public
COPY tools.manifest.json ./tools.manifest.json

USER assistant

ENV NODE_ENV=production
ENV PORT=8090
EXPOSE 8090

CMD ["node", "src/index.js"]
