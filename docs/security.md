# Sécurité — Authentification, RBAC & isolation multi-tenant

Ce document décrit le modèle de sécurité mis en place pour l'API Liyanza
(ticket `BACK-106`, sur la base de `BACK-105` et `BACK-102`).

## 1. Vue d'ensemble

Trois mécanismes complémentaires protègent chaque requête, dans cet ordre :

1. **Authentification** (`JwtAuthGuard`, global) — vérifie que la requête
   porte un JWT valide (signature + expiration). Rejette avec `401` sinon.
2. **Autorisation par rôle** (`RolesGuard`, global) — vérifie que le rôle de
   l'utilisateur authentifié fait partie des rôles autorisés sur l'endpoint.
   Rejette avec `403` sinon.
3. **Isolation multi-tenant** (`CompanyScopeGuard` / `assertSameCompany()`,
   opt-in par endpoint) — vérifie que la ressource demandée appartient bien à
   l'entreprise (`Company`) de l'utilisateur. Rejette avec `404` sinon (pour
   ne pas révéler l'existence de ressources d'entreprises tierces).

```
Requête HTTP
   │
   ▼
JwtAuthGuard  ──(pas de token / token invalide)──▶ 401 Unauthorized
   │ (@Public() => bypass)
   ▼
RolesGuard    ──(rôle non autorisé)──▶ 403 Forbidden
   │ (pas de @Roles() => bypass)
   ▼
CompanyScopeGuard / assertSameCompany()  ──(entreprise différente)──▶ 404 Not Found
   │
   ▼
Handler métier
```

## 2. Deny-by-default

`JwtAuthGuard` et `RolesGuard` sont enregistrés **globalement**
(`APP_GUARD` dans `AppModule`). Conséquence directe : **tout nouvel endpoint
créé dans les phases suivantes est protégé automatiquement**, sans avoir à
ajouter `@UseGuards(...)` manuellement. C'est un choix délibéré pour éliminer
le risque d'oubli identifié dans le ticket.

Pour exempter un endpoint (ex: login, health check infra), utiliser
explicitement :

```ts
import { Public } from 'src/modules/auth/decorators/public.decorator';

@Public()
@Post('login')
login(@Body() dto: LoginDto) { ... }
```

**Endpoints actuellement publics** :

| Endpoint              | Raison                                                                |
| --------------------- | --------------------------------------------------------------------- |
| `POST /auth/register` | Création de compte, pas encore authentifié                            |
| `POST /auth/login`    | Authentification elle-même                                            |
| `POST /auth/refresh`  | Renouvellement de session via refresh token (pas un access token JWT) |
| `GET /`               | Racine applicative                                                    |
| `GET /health`         | Probe infra AWS ALB / ECS, appelée sans JWT                           |

## 3. Rôles applicatifs (`enum Role`, `BACK-102`)

| Rôle                | Description métier (cadrage — "sous-comptes & permissions")                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `ADMIN`             | Administrateur de l'entreprise : gère les sous-comptes, les permissions, la configuration de la plateforme pour son entreprise |
| `MARKETING_MANAGER` | Responsable marketing : crée/pilote les campagnes, consulte les analyses et recommandations, valide les budgets                |
| `COMMUNITY_MANAGER` | Chargé de communication / community manager : exécute les tâches liées aux campagnes (contenu, diffusion, canaux)              |
| `PROVIDER`          | Prestataire terrain : installe les supports publicitaires et transmet les preuves de publication géolocalisées                 |

> ⚠️ Ces rôles sont définis au niveau de l'`Entreprise` (multi-tenant) : un
> `ADMIN` de l'entreprise A n'a aucune autorité sur l'entreprise B — le rôle
> seul ne suffit jamais, il est toujours combiné à la vérification
> `companyId` (section 5).

## 4. Matrice rôles ↔ permissions (fonctionnalités du cadrage)

Cette matrice sert de référence pour l'annotation `@Roles(...)` des futurs
contrôleurs métier. Elle sera affinée module par module au fil des tickets ;
elle reflète l'intention fonctionnelle actuelle du cadrage.

| Fonctionnalité                                                      | `ADMIN` | `MARKETING_MANAGER` | `COMMUNITY_MANAGER` | `PROVIDER` |
| ------------------------------------------------------------------- | :-----: | :-----------------: | :-----------------: | :--------: |
| Gérer les sous-comptes & permissions                                |   ✅    |         ❌          |         ❌          |     ❌     |
| Définir objectifs / budget / cible d'une campagne                   |   ✅    |         ✅          |         ❌          |     ❌     |
| Lancer une campagne marketing                                       |   ✅    |         ✅          |         ❌          |     ❌     |
| Ajouter le contenu d'un spot, choisir les canaux                    |   ✅    |         ✅          |         ✅          |     ❌     |
| Soumettre un spot à validation                                      |   ✅    |         ✅          |         ✅          |     ❌     |
| Simuler les performances d'une campagne                             |   ✅    |         ✅          |         ❌          |     ❌     |
| Consulter le monitoring de diffusion / conformité radio             |   ✅    |         ✅          |         ✅          |     ❌     |
| Générer des rapports de conformité                                  |   ✅    |         ✅          |         ❌          |     ❌     |
| Photographier une installation (preuve de publication géolocalisée) |   ❌    |         ❌          |         ❌          |     ✅     |
| Consulter le tableau de bord / statistiques                         |   ✅    |         ✅          |    ✅ (lecture)     |     ❌     |
| Générer / exporter des rapports                                     |   ✅    |         ✅          |         ❌          |     ❌     |
| Utiliser l'assistant IA marketing                                   |   ✅    |         ✅          |         ✅          |     ❌     |
| Analyser les performances / recommandations / ROI                   |   ✅    |         ✅          |         ❌          |     ❌     |

**Utilisation dans le code :**

```ts
import { Roles } from 'src/modules/auth/decorators/roles.decorator';
import { Role } from '@prisma/client';

@Roles(Role.ADMIN, Role.MARKETING_MANAGER)
@Post('campaigns')
create(@Body() dto: CreateCampaignDto) { ... }
```

Un endpoint **sans** `@Roles(...)` reste accessible à tout utilisateur
authentifié, quel que soit son rôle (seul `JwtAuthGuard` s'applique).

## 5. Isolation multi-tenant (« Ownership »)

Chaque `User` appartient à 0 ou 1 `Company` (`companyId`, cf. MCD —
relation `APPARTENIR_ENTREPRISE`). Cette `companyId` est :

- incluse dans le payload du JWT à la connexion (`AuthService.login`) ;
- exposée dans `request.user.companyId` par `JwtStrategy.validate()` ;
- **toujours nulle par défaut pour un accès refusé** : un utilisateur sans
  entreprise ne peut accéder à aucune ressource scopée par entreprise.

Deux outils, pour deux cas de figure différents :

### a) `CompanyScopeGuard` — la companyId est dans l'URL

Pour les routes de la forme `/companies/:companyId/...` :

```ts
import { CompanyScopeGuard } from 'src/modules/auth/guards/company-scope.guard';

@UseGuards(CompanyScopeGuard)
@Get('companies/:companyId/campaigns')
findAll(@Param('companyId') companyId: string) { ... }
```

### b) `assertSameCompany()` — la companyId n'est connue qu'après lecture en base

Pour les ressources imbriquées (`/campaigns/:id`, `/installations/:id`, etc.),
où la `companyId` de la ressource dépend de données métier (ex: la
`companyId` du lanceur de la campagne) :

```ts
import { assertSameCompany } from 'src/modules/auth/utils/company-scope.util';

const campaign = await this.prisma.campaign.findUnique({
  where: { id },
  include: { launchedBy: true },
});
if (!campaign) throw new NotFoundException('Campagne introuvable.');
assertSameCompany(user, campaign.launchedBy.companyId, 'Campagne');
```

Dans les deux cas, un mismatch d'entreprise renvoie **404** (et non 403) afin
de ne pas révéler à un utilisateur l'existence de ressources appartenant à
une entreprise tierce.

## 6. En-têtes de sécurité HTTP & CORS

- **`helmet`** est activé globalement dans `main.ts` (`app.use(helmet())`),
  avant toute autre configuration, pour poser les en-têtes de sécurité
  standards (`X-Content-Type-Options`, `X-Frame-Options`,
  `Strict-Transport-Security`, etc.).
- **CORS** est configuré avec une whitelist explicite d'origines, chargée
  depuis la variable d'environnement `CORS_ORIGINS` (liste séparée par des
  virgules — Web App + Mobile App/dev). Aucune origine hors liste n'est
  acceptée. Un wildcard `*` fait échouer le démarrage de l'application si
  `NODE_ENV=production`.
- Les requêtes sans en-tête `Origin` (curl, apps mobiles natives, appels
  serveur-à-serveur, health checks) ne sont pas concernées par CORS (qui est
  une politique appliquée par les navigateurs) et sont toujours acceptées à
  ce niveau — elles restent bien sûr soumises à `JwtAuthGuard`/`RolesGuard`.

Variable d'environnement associée (`.env`) :

```
CORS_ORIGINS=https://app.liyanza.com,https://admin.liyanza.com
```

## 7. Vérification manuelle (Definition of Done)

```bash
# 1) 401 sans token
curl -i http://localhost:3000/auth/me
# => HTTP/1.1 401 Unauthorized

# 2) login pour récupérer un access token
curl -s -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"..."}'

# 3) 200 avec un token valide
curl -i http://localhost:3000/auth/me \
  -H "Authorization: Bearer <ACCESS_TOKEN>"

# 4) 403 avec un rôle insuffisant (utilisateur non-ADMIN)
curl -i http://localhost:3000/auth/admin-check \
  -H "Authorization: Bearer <ACCESS_TOKEN_NON_ADMIN>"
# => HTTP/1.1 403 Forbidden

# 5) en-têtes helmet + CORS visibles dans la réponse
curl -i http://localhost:3000/health
# => X-Content-Type-Options, X-Frame-Options, etc. présents
```

## 8. Points de vigilance pour les futurs modules métier

- Ne jamais dupliquer la logique RBAC dans un contrôleur : toujours passer
  par `@Roles(...)` + `RolesGuard` (déjà global).
- Toute nouvelle route exposant une ressource métier (`Campaign`,
  `Installation`, `Broadcast`, ...) doit systématiquement appliquer
  `assertSameCompany()` (ou `CompanyScopeGuard` si la companyId est dans
  l'URL) avant de retourner ou modifier la ressource.
- Mettre à jour la matrice de la section 4 dès qu'une nouvelle
  fonctionnalité/endpoint est ajoutée.
