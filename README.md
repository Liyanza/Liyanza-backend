# Liyanza-backend

API core du projet **Liyanza** — Plateforme IA de Marketing Intelligent pour les Marchés Émergents.

## 🏗️ Place dans l'écosystème

Ce dépôt est le backend principal (NestJS / TypeScript) de la plateforme Liyanza. Il expose l'API REST consommée par :

- [`Liyanza`](https://github.com/LIYANZA/Liyanza) — Web App & Admin (Next.js)
- [`Liyanza-mobile`](https://github.com/LIYANZA/Liyanza-mobile) — Application mobile (Flutter)

## 🛠️ Stack technique

- **Framework** : NestJS (TypeScript, strict mode)
- **Architecture** : MVC modulaire
- **ORM** : Prisma (à intégrer en Phase 1)
- **Base de données** : PostgreSQL 16+
- **Cache** : Redis
- **Documentation API** : Swagger / OpenAPI 3.0
- **Tests** : Jest
- **CI/CD** : GitHub Actions
- **Déploiement** : AWS ECS Fargate

## 🚀 Démarrage local

```bash
# 1. Cloner le dépôt
git clone https://github.com/LIYANZA/Liyanza-backend.git
cd Liyanza-backend

# 2. Installer les dépendances
npm ci

# 3. Démarrer en mode développement
npm run start:dev