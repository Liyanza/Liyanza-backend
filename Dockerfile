# Stage 1: Builder
FROM node:20-alpine AS builder
WORKDIR /app

# Copier les fichiers de configuration (package, tsconfig, nest-cli, prisma)
COPY package*.json ./
COPY tsconfig*.json ./
COPY nest-cli.json ./
COPY prisma.config.ts ./

RUN npm install

# Copier tout le reste du code source (y compris prisma/schema.prisma)
COPY . .

# Générer le client Prisma (indispensable pour les types)
RUN npx prisma generate

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
COPY --from=builder --chown=nodejs:nodejs /app/prisma.config.ts ./prisma.config.ts   

USER nodejs
EXPOSE 3000

# Exécuter les migrations au démarrage puis lancer l'API
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/main"]