# build stage
FROM node:20-slim AS base
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

# tree-sitter wasm grammars fetched at build time (see src/scan/parse.js for the load list)
ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "src/server.js"]
