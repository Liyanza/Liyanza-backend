# Contributing — Liyanza-backend

## Conventions de branches

| Préfixe | Usage |
|---------|-------|
| `feature/` | Nouvelle fonctionnalité |
| `fix/` | Correction de bug |
| `chore/` | Tâche technique, refactoring, dépendances |

Exemple : `feature/BACK-101-prisma-integration`

## Conventions de commits (Conventional Commits)

<type><scope><description>
[optional body]
[optional footer]
plain

Types autorisés : `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

Exemple :
feat(auth): implement JWT login endpoint
Closes BACK-105

## Process de merge

1. Créer une branche à partir de `main`
2. Ouvrir une Pull Request vers `main`
3. **1 review obligatoire** avant merge
4. La CI doit être verte