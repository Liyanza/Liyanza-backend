# Contributing — Liyanza-backend

## Conventions de branches

| Préfixe    | Usage                                     |
| ---------- | ----------------------------------------- |
| `feature/` | Nouvelle fonctionnalité                   |
| `fix/`     | Correction de bug                         |
| `chore/`   | Tâche technique, refactoring, dépendances |

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

## Hooks Git

Des hooks sont installés automatiquement après `npm install` (via Husky) :

- **pre-commit** : exécute `lint-staged` pour formater et corriger les fichiers modifiés.
- **commit-msg** : valide le message selon la convention [Conventional Commits](https://www.conventionalcommits.org/).

En cas d’urgence (à éviter), vous pouvez bypasser les hooks avec `--no-verify` :

```bash
git commit -m "fix: hotfix critical bug" --no-verify

## Process de merge

1. Créer une branche à partir de `main`
2. Ouvrir une Pull Request vers `main`
3. **1 review obligatoire** avant merge
4. La CI doit être verte
```
