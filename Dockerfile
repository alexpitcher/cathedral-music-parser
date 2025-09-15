FROM node:20-alpine AS base

WORKDIR /app

# Install dependencies first (leverage layer cache)
COPY package.json package-lock.json* ./
RUN npm ci --only=production || npm i --only=production

# Copy app source
COPY src ./src
COPY README.md ./

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/server.js"]

