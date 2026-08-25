# Stage 1: Builder
FROM node:20-alpine AS builder
WORKDIR /app

# Copier les fichiers de configuration (package, tsconfig, nest-cli, prisma)
COPY package*.json ./
COPY tsconfig*.json ./
COPY nest-cli.json ./
COPY prisma.config.ts ./

RUN npm install

# Copier tout le reste du code source
COPY . .

# Compiler
RUN npm run build

# Stage 2: Runner
FROM node:20-alpine AS runner
WORKDIR /app

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

# Copier les artefacts
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nodejs:nodejs /app/prisma ./prisma

USER nodejs
EXPOSE 3000
CMD ["node", "dist/src/main"]