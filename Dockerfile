# Stage 1: Builder
FROM node:20-alpine AS builder
WORKDIR /app

# Copie des fichiers de dépendances pour profiter du cache Docker
COPY package*.json ./
RUN npm install

# Copie du reste du code source et compilation
COPY . .
RUN npm run build

# Stage 2: Runner
FROM node:20-alpine AS runner
WORKDIR /app

# Création d'un utilisateur non-root pour la sécurité
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copie des artefacts de build depuis le stage builder
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./package.json

# Utilisation de l'utilisateur non-root
USER nodejs

EXPOSE 3000
CMD ["node", "dist/main"]