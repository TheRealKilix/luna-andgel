FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.js index.html manifest.webmanifest app-icon.svg app-icons.css pwa.js enhancements.js sw.js ./
RUN mkdir -p /app/data && chown -R node:node /app

ENV PORT=3000
ENV DATA_DIR=/app/data
EXPOSE 3000
USER node
CMD ["node", "server.js"]
