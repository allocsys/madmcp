# build stage
FROM node:20-slim AS base
WORKDIR /app

COPY package.json package-lock.json* ./
COPY scripts ./scripts
RUN npm install --omit=dev

COPY src ./src

# Vendor the tree-sitter wasm grammars parse.js needs (see
# src/scan/parse.js LANGUAGE_BY_EXT / scripts/copy-grammars.js), then drop
# the source package — it's ~12MB and only needed at build time.
RUN node scripts/copy-grammars.js && rm -rf node_modules/tree-sitter-wasms

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "src/server.js"]
