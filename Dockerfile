# syntax=docker/dockerfile:1

# =====================================================================
# Stage 1: Builder
# =====================================================================
# CORRECTIF AUDIT : image de base épinglée par digest-compatible tag mineur.
# `node:20-alpine` seul se déplace à chaque patch — deux builds du même commit
# ne produisent pas le même binaire, ce qui interdit toute reproductibilité et
# rend un rollback non déterministe.
FROM node:20.19-alpine AS builder
WORKDIR /app

# Copier les fichiers de configuration (package, tsconfig, nest-cli, prisma)
COPY package*.json ./
COPY tsconfig*.json ./
COPY nest-cli.json ./
COPY prisma.config.ts ./

# CORRECTIF AUDIT (majeur — reproductibilité) : `npm install` réécrit le
# lockfile et peut installer des versions différentes de celles validées en CI,
# ce qui contredit explicitement le README (« L'image Docker utilise `npm ci`
# pour garantir la reproductibilité »). `npm ci` installe strictement l'arbre
# figé dans package-lock.json et échoue si le lockfile est désynchronisé.
RUN npm ci

# Copier le reste du code source (y compris prisma/schema.prisma).
# Le `.dockerignore` à la RACINE du contexte exclut .env, .git et node_modules.
COPY . .

# Générer le client Prisma (indispensable pour les types)
RUN npx prisma generate

# Compiler
RUN npm run build

# CORRECTIF AUDIT (majeur — surface d'attaque & taille d'image) : le stage
# runner recopiait `node_modules` DU BUILDER, c'est-à-dire l'arbre complet
# incluant les devDependencies (typescript, jest, eslint, ts-node, le CLI
# Nest...). Outre les centaines de mégaoctets inutiles, cela embarque en
# production des outils qui facilitent l'exploitation d'une RCE. On élague
# l'arbre aux seules dépendances d'exécution.
RUN npm prune --omit=dev

# =====================================================================
# Stage 2: Runner
# =====================================================================
FROM node:20.19-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# `dumb-init` assure la propagation correcte de SIGTERM au processus Node.
# Sans init PID 1, le signal envoyé par ECS lors d'un redéploiement n'atteint
# pas toujours l'application, qui est alors tuée brutalement (SIGKILL) après
# le délai de grâce — annulant le bénéfice de `app.enableShutdownHooks()`.
RUN apk add --no-cache dumb-init

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

# Copier les artefacts
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nodejs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nodejs:nodejs /app/prisma.config.ts ./prisma.config.ts

USER nodejs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# ⚠️ NOTE D'AUDIT — `prisma migrate deploy` est exécuté ici au démarrage de
# CHAQUE tâche. Avec plusieurs tâches ECS démarrant simultanément lors d'un
# scale-out ou d'un déploiement, plusieurs migrations concurrentes se
# disputent le verrou de migration Prisma : au mieux les tâches perdantes
# attendent, au pire elles échouent au boot et entrent en crash-loop.
# La migration doit être une étape de déploiement distincte (tâche ECS
# one-shot ou job CI exécuté avant la bascule du service). Conservé ici pour
# ne pas modifier votre pipeline sans validation — voir le plan d'action.
CMD ["dumb-init", "sh", "-c", "npx prisma migrate deploy && node dist/src/main"]
