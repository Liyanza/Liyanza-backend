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

## 🐳 Démarrer avec Docker (environnement complet)

L'environnement de développement complet (API + PostgreSQL + Redis) peut être lancé en une seule commande via Docker Compose.

**Prérequis** : Docker et Docker Compose installés sur votre machine.

### Première exécution

1.  **Générer le fichier de verrouillage** :
    - L'image Docker utilise `npm ci` pour garantir la reproductibilité.
    - Avant de builder, exécutez `npm install` en local pour générer le `package-lock.json`. **Commitez ce fichier** dans le dépôt.
2.  **Lancer tous les services** :
    ```bash
    docker compose up -d
    ```

## 🚀 Démarrage local

```bash
# 1. Cloner le dépôt
git clone https://github.com/LIYANZA/Liyanza-backend.git
cd Liyanza-backend

# 2. Installer les dépendances
npm ci

# 3. Démarrer en mode développement
npm run start:dev
```
