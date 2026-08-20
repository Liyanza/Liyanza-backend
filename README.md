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

## 🔐 Variables d'environnement

L'application utilise `@nestjs/config` avec validation stricte au démarrage.

| Variable         | Requise | Description                                    | Exemple                                    |
| ---------------- | ------- | ---------------------------------------------- | ------------------------------------------ |
| `NODE_ENV`       | Oui     | Environnement d'exécution                      | `development`, `production`, `test`        |
| `PORT`           | Oui     | Port d'écoute de l'API                         | `3000`                                     |
| `DATABASE_URL`   | Oui     | URL de connexion PostgreSQL                    | `postgresql://user:pass@localhost:5432/db` |
| `REDIS_URL`      | Oui     | URL de connexion Redis                         | `redis://localhost:6379`                   |
| `JWT_SECRET`     | Oui     | Clé secrète pour signer les tokens JWT         | `supersecretkey`                           |
| `JWT_EXPIRATION` | Non     | Durée de validité des tokens (par défaut `7d`) | `7d`, `1h`, `30m`                          |

> ⚠️ **Important** : Ne jamais logger l'intégralité de la configuration (risque de fuite de secrets). Utilisez `ConfigService` uniquement pour accéder aux valeurs nécessaires.

Pour lancer l'application en local, copiez `.env.example` vers `.env` et ajustez les valeurs si besoin :

````bash
cp .env.example .env

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

# 3. Appliquer les migrations Prisma et générer le client
npx prisma migrate dev

# 4. Peupler la base avec un jeu de données de test (voir section dédiée ci-dessous)
npx prisma db seed

# 5. Démarrer en mode développement
npm run start:dev
````

## 🌱 Jeu de données de développement (seed)

Pour éviter à chaque développeur de recréer manuellement une entreprise et des
utilisateurs de test, le dépôt fournit un script de seed Prisma
(`prisma/seed.ts`) qui insère :

- **1 entreprise** de test (`Liyanza Demo SARL`) ;
- **3 utilisateurs**, un par rôle clé (voir `docs/security.md` pour le détail
  des rôles) : `ADMIN`, `MARKETING_MANAGER`, `PROVIDER` — mots de passe
  hachés avec le même coût que `AuthService` (bcrypt, 10 rounds) ;
- **1 campagne** et **1 canal de diffusion** d'exemple, pour tester
  manuellement les endpoints de la Phase 2 sans passer par les formulaires de
  création à chaque fois.

### Exécuter le seed

```bash
# Recrée le schéma depuis zéro PUIS exécute automatiquement le seed
npx prisma migrate reset

# Ou, sans toucher au schéma : exécute uniquement le seed
npx prisma db seed
```

Le script est **idempotent** : il utilise `upsert` sur des identifiants fixes
et peut donc être relancé autant de fois que nécessaire sans dupliquer les
données ni provoquer d'erreur de contrainte unique.

### Comptes de test

Les identifiants exacts (email + mot de passe) sont affichés dans la console
à la fin de l'exécution du seed. Ils sont volontairement complexes (pas de
mot de passe faible ou devinable), même si leur usage reste local.

> ⚠️ **Le script refuse de s'exécuter si `NODE_ENV=production`** — c'est la
> garde principale empêchant toute fuite de données de seed vers un
> environnement réel. Ne contournez jamais cette vérification.
