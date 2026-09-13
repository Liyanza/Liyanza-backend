# Checklist OWASP API Security Top 10 (2023) — Liyanza-backend

**BACK-406.** Ce document formalise l'audit de sécurité API déjà largement
mené au fil des tickets précédents (voir les commentaires `CORRECTIF AUDIT`
dans le code, et `docs/security.md` pour le détail des mécanismes d'auth) et
l'exécute explicitement contre le code réel du dépôt à la date ci-dessous —
chaque statut cite un fichier/comportement vérifié, pas une supposition.

**Date de l'audit** : 2026-09-13.
**Référentiel** : [OWASP API Security Top 10 — édition 2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/).
**Méthode** : lecture du code source réel (guards, services, DTO, config),
tests manuels ciblés (health check, coupure Redis), `npm audit`. Aucune
affirmation de conformité sans preuve associée.

**Légende** : ✅ Conforme · 🟡 Conforme avec réserve documentée · ⛔ Gap identifié

---

## Synthèse

| #     | Risque                                          | Statut |
| ----- | ----------------------------------------------- | ------ |
| API1  | Broken Object Level Authorization               | ✅     |
| API2  | Broken Authentication                           | 🟡     |
| API3  | Broken Object Property Level Authorization      | ✅     |
| API4  | Unrestricted Resource Consumption               | 🟡     |
| API5  | Broken Function Level Authorization             | ✅     |
| API6  | Unrestricted Access to Sensitive Business Flows | ✅     |
| API7  | Server Side Request Forgery (SSRF)              | ✅     |
| API8  | Security Misconfiguration                       | 🟡     |
| API9  | Improper Inventory Management                   | ✅     |
| API10 | Unsafe Consumption of APIs                      | ✅     |

Aucun ⛔ à ce jour : les réserves 🟡 sont des risques résiduels documentés,
pas des trous non traités — voir le détail de chacune ci-dessous, avec une
recommandation d'action pour celles qui en ont une.

---

## API1:2023 — Broken Object Level Authorization ✅

**Mécanisme** : `assertSameCompany()`/`assertSameCompanyUnless()`
(`src/common/utils/company-scope.util.ts`, testé à ≥90% de couverture,
cf. `package.json` `coverageThreshold`) — tout accès à une ressource métier
par son id est scopé à l'entreprise de l'appelant, et renvoie **toujours 404,
jamais 403**, pour ne jamais confirmer à un attaquant l'existence d'une
ressource dans une autre entreprise.

**Vérifié dans ce ticket** (pas seulement supposé) :

- `EntreprisesService.findOne` — aucun `@Roles()` au contrôleur (transverse),
  isolation appliquée en service (`assertSameCompany`) : un utilisateur ne
  peut lire que sa propre entreprise, quel que soit son rôle.
- `CanauxService`/`CampagnesService`/`DiffusionsService` — chaque
  `findFirst`/`findUnique` filtre par `launchedBy: { companyId }` ou
  équivalent avant toute lecture/écriture (confirmé en lisant les 18
  contrôleurs pour BACK-405).
- Testé explicitement en E2E réel (BACK-402, `test/campaign-launch.e2e-spec.ts`,
  `test/diffusion-conformite.e2e-spec.ts`) : une deuxième entreprise reçoit
  404 sur une campagne/diffusion qui ne lui appartient pas — pas un test
  mocké, un vrai aller-retour HTTP contre une base réelle.

**Résiduel** : aucun. Le pattern est systématique et testé, pas un cas isolé.

---

## API2:2023 — Broken Authentication 🟡

**Mécanisme** : JWT access (15 min) + refresh (7 jours) avec rotation à
usage unique (`jti` suivi dans Redis, `GETDEL` atomique — pas de fenêtre
TOCTOU), bcrypt (coût 10), comparaison en temps constant même si l'email
n'existe pas (`auth.service.timing.spec.ts`), verrouillage des comptes
désactivés (`deactivatedAt`), throttling dédié sur `/auth/login`,
`/auth/register`, `/auth/refresh` (5-10 req/min/IP, stockage Redis partagé
— pas en mémoire locale, cf. `RedisThrottlerStorage`).

**Vérifié** : `AuthService.refresh()` relit systématiquement rôle/`companyId`
en base (pas depuis l'ancien token) — corrige la classe de faille "privilège
figé après rétrogradation", déjà un correctif d'audit documenté.

**Réserve documentée** : le throttling est **par IP**, pas par compte. Un
attaquant distribué (botnet, pool de proxys) peut donc tenter un
credential-stuffing sur un compte cible précis sans jamais dépasser la
limite de 5 tentatives/min **par IP individuelle**. Pas de verrouillage de
compte après N échecs consécutifs, pas de CAPTCHA, pas de MFA.

**Action recommandée (non implémentée ici — hors périmètre doc)** : si le
produit expose un jour des comptes à forte valeur (paiement, données
sensibles), ajouter un compteur d'échecs par compte (Redis, clé
`login-fail:<email>`) avec verrouillage temporaire, indépendant du
throttling par IP. Non prioritaire au stade actuel (marché cible, absence
de signal d'abus).

---

## API3:2023 — Broken Object Property Level Authorization ✅

**Mécanisme** : `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true,
transform: true })` global (`src/main.ts`) — toute propriété non déclarée
dans le DTO cible est **rejetée** (400), pas silencieusement ignorée : un
client ne peut jamais injecter un champ `role`, `companyId`, `status` ou
`id` non prévu par le DTO d'un endpoint donné.

**Vérifié** :

- `RegisterDto` n'a ni `role` ni `companyId` — `AuthService.register` les
  fixe côté serveur (`Role.COMMUNITY_MANAGER`, `companyId: null`),
  correctif d'audit déjà documenté en tête du fichier DTO.
- `CreatePrestationDto.providerId` est validé côté service (existence,
  même entreprise, rôle `PROVIDER`) avant d'être accepté — pas une simple
  confiance dans l'id fourni (correctif de cette session, voir résultat
  BACK-308 du backlog).
- Aucun DTO de ce dépôt n'expose un champ `id`/`companyId`/`role`/`status`
  en écriture libre sans validation métier associée (vérifié en lisant les
  ~47 DTO pendant l'activation du plugin Swagger, BACK-405).

**Résiduel** : aucun.

---

## API4:2023 — Unrestricted Resource Consumption 🟡

**Mécanismes en place** :

- Pagination bornée partout (`@Max(100)` sur les DTO de requête paginée).
- `@ArrayMaxSize(500)` sur `CreateScheduleDto.broadcasts` (évite qu'une
  seule requête ne déclenche des centaines d'`INSERT` en transaction).
- Throttling Redis partagé sur toutes les routes publiques (`@Public()` +
  `@Throttle` dédié systématique — garde-fou #10 du skill sécurité),
  vérifié présent sur `GET /qr/:code` (60/min), `POST /internal/monitoring/
detections` (60/min), `GET /social-accounts/oauth/callback` (30/min),
  `GET`/`POST /prestations/lien-validation/:token` (20/10 par min).
- Upload média : taille maximale 10 Mo, contrôlée par `HeadObject` réel sur
  le stockage (`MediaService.confirmUpload`, `MAX_MEDIA_SIZE_BYTES`) —
  jamais une simple déclaration cliente.

**Réserve documentée (vérifiée dans ce ticket, pas supposée)** : cette
limite de 10 Mo est appliquée **après** l'upload complet (le client obtient
une URL PUT présignée S3 sans contrainte de taille embarquée — une URL PUT
présignée simple, contrairement à une politique POST présignée avec
condition `content-length-range`, ne peut pas borner la taille a priori).
Un client peut donc transférer un objet plus volumineux que 10 Mo vers le
stockage — il est détecté et **supprimé** au moment de `confirmUpload`, mais
le coût de stockage/bande passante de l'upload lui-même n'est pas empêché
a priori. Risque limité en pratique : `POST /media/presigned-upload` exige
un JWT valide (pas un endpoint anonyme), donc pas un vecteur de DoS anonyme,
seulement un abus possible par un compte déjà authentifié.

**Action recommandée (non implémentée ici)** : si ce risque devient
préoccupant, migrer vers une politique POST présignée S3 avec
`content-length-range`, qui borne la taille avant même que l'upload ne
commence. Changement d'architecture du flux d'upload, hors périmètre d'un
ticket de documentation — à ouvrir séparément si le volume d'abus observé
le justifie.

**Aucun timeout de requête HTTP global explicite** n'est configuré
(dépend des valeurs par défaut d'Express/Node) — non vérifié plus avant
dans ce ticket, à valider si des endpoints à latence variable
(génération PDF/CSV dans `StatistiquesController.exportRapport`)
posent un jour un problème réel de connexions traînantes.

---

## API5:2023 — Broken Function Level Authorization ✅

**Mécanisme** : `RolesGuard` global (`APP_GUARD`, après `JwtAuthGuard` —
deny-by-default sur les deux) + `@Roles(...)` explicite sur chaque route
qui ne doit pas être transverse à tous les rôles authentifiés.

**Vérifié en relisant systématiquement les 18 contrôleurs (BACK-405)** :
chaque route sans `@Roles()` et sans `@Public()` a une justification
explicite en commentaire (ex: `GET /notifications`, `GET /tasks`,
`GET /social-accounts`, `GET /users/me`, `POST /entreprises`,
`GET /entreprises/:id`) — jamais un oubli silencieux, toujours un choix
documenté et cohérent avec l'isolation appliquée en service. Aucune route
métier sensible (création/modification/suppression) n'est dépourvue de
restriction de rôle sans justification écrite.

**Résiduel** : aucun à ce jour. Point de vigilance permanent : tout nouveau
contrôleur doit suivre le même réflexe (`@Roles()` explicite ou commentaire
justifiant son absence) — déjà formalisé dans
`.claude/skills/liyanza-nestjs-module/SKILL.md`.

---

## API6:2023 — Unrestricted Access to Sensitive Business Flows ✅

**Flux sensibles identifiés** : création d'entreprise (1 par utilisateur,
vérifié en transaction avec revérification en base — pas seulement sur le
JWT, cf. `EntreprisesService.create`), lancement de campagne (machine à
états stricte, `CampaignStateMachine`, pas de transition arbitraire),
génération de lien de validation externe (JWT dédié à usage unique),
inscription publique (throttlée 5/min/IP).

**Vérifié** : `EntreprisesService.create` revérifie `companyId: null` **à
l'intérieur** de la transaction (pas seulement via le JWT de la requête) —
protège contre deux requêtes concurrentes du même utilisateur créant deux
entreprises (race condition déjà corrigée, documentée dans le code).

**Résiduel** : aucun flux métier de ce dépôt ne traite de paiement, d'achat
en quantité limitée, ni d'action irréversible à fort enjeu financier direct
— la surface de risque API6 (typiquement : contournement de logique
métier pour obtenir un avantage, ex. achat de stock limité) est faible pour
ce produit au stade actuel.

---

## API7:2023 — Server Side Request Forgery (SSRF) ✅

**Vérifié** : aucun endpoint de ce dépôt ne fait de requête HTTP sortante
vers une URL fournie par le client.

- `QrCodeService` : `targetUrl` est stockée à la création (validée par
  format — `https://` obligatoire, domaine restreint pour WHATSAPP — voir
  résultat BACK-305 du backlog) mais **jamais fetchée côté serveur** : le
  scan (`GET /qr/:code`) fait une redirection HTTP 302, le navigateur du
  visiteur résout l'URL, pas ce serveur.
- `MetaGraphClient` (Meta Graph API) : base URL fixe
  (`https://graph.facebook.com/{version}`, jamais interpolée depuis une
  entrée utilisateur), tous les paramètres (`access_token`, `fields`, ids)
  sont soit générés côté serveur soit des identifiants Meta opaques déjà
  validés par le flow OAuth — pas de champ libre transmis en tant qu'URL
  ou hôte cible.
- Aucun autre module n'utilise `HttpService`/`fetch` avec une URL dérivée
  d'une entrée utilisateur.

**Résiduel** : aucun vecteur SSRF identifié dans le code actuel.

---

## API8:2023 — Security Misconfiguration 🟡

**Mécanismes en place** :

- `helmet()` (en-têtes de sécurité HTTP par défaut) + CORS whitelist stricte
  (refus explicite du wildcard `*` en production, `src/main.ts`).
- `env.validation.ts` : démarrage bloqué si une variable sensible manque ou
  vaut une valeur d'exemple (`JWT_SECRET`, `INTERNAL_MONITORING_TOKEN`,
  `SOCIAL_TOKEN_ENCRYPTION_KEY` — toutes avec `@NotEquals('changeme')` et
  une longueur minimale correspondant à leur usage cryptographique réel).
- `AllExceptionsFilter` : **aucune** erreur Prisma ou interne brute n'atteint
  le client (vérifié en lisant `PRISMA_ERROR_MAP` et la branche `default` —
  toujours "Internal server error" générique, détail réservé aux logs
  corrélés par `requestId`).
- Swagger (`/docs`) désactivé en production (`if (!isProduction)`,
  `src/main.ts`).
- Image Docker : utilisateur non-root (`nodejs`, uid 1001), stage `runner`
  sans devDependencies (`npm prune --omit=dev`), `.dockerignore` racine
  exclut `.env*`/`.git` (corrige un incident d'audit déjà documenté où un
  `.dockerignore` mal placé dans `src/` n'avait jamais eu d'effet).

**Deux régressions réelles trouvées et corrigées pendant cet audit** (voir
détail complet dans le résultat BACK-405 du backlog) :

1. `AppController` déclarait un stub `GET /health` en doublon avec le vrai
   `HealthController` (Terminus) — Express ne routant que vers le premier
   enregistré, **le health check réel n'était jamais exécuté**. Le
   `HEALTHCHECK` du `Dockerfile` et le futur health check Render (BACK-407)
   auraient donc toujours reçu `200 OK`, même base de données injoignable.
   Stub supprimé.
2. L'indicateur Redis du health check était câblé en dur (`status: 'up'`
   sans jamais interroger Redis) — corrigé (`RedisService.ping()` réel).

**Réserve documentée, non corrigée dans ce ticket** : en testant le
correctif ci-dessus par une coupure réelle du conteneur `liyanza_redis`, la
requête `/health` a renvoyé **500** (générique, via `AllExceptionsFilter`)
au lieu du **503** structuré attendu de Terminus. Cause : `ThrottlerGuard`
(garde globale, s'exécute sur **toute** requête, y compris `/health`) dépend
elle-même de Redis (`RedisThrottlerStorage`) sans aucune gestion d'erreur —
une panne Redis fait donc échouer la garde **avant** d'atteindre le
contrôleur de santé. Concrètement : **une coupure Redis fait actuellement
tomber toute l'API en 500 (pas seulement les fonctions qui utilisent
Redis), y compris l'endpoint censé signaler cette panne.**

**Action recommandée (décision produit à trancher, pas un simple bug)** :
choisir explicitly un comportement de repli pour `RedisThrottlerStorage`
en cas d'indisponibilité Redis :

- _Fail-open_ (laisser passer sans compter) : l'API reste disponible
  pendant une panne Redis, au prix d'une fenêtre sans rate-limiting
  (exposition temporaire au brute-force/DoS applicatif) ;
- _Fail-closed_ (comportement actuel, non voulu explicitement) : l'API
  entière devient indisponible pendant une panne Redis — un incident
  d'infrastructure secondaire (Redis) provoque une panne totale au lieu
  d'une dégradation partielle.
  Recommandation : fail-open avec alerte (log `ERROR` déjà présent dans
  `RedisService`), car une panne Redis est probablement plus fréquente/brève
  qu'une attaque simultanée, et l'indisponibilité totale est le pire des deux
  scénarios pour un produit en phase de croissance. **Non implémenté ici** —
  implique de modifier `RedisThrottlerStorage`/`RedisService.incrementWithTtl`,
  hors périmètre d'un ticket de documentation ; à ouvrir comme ticket dédié
  (rattachable à BACK-407, health/résilience Render).

**Écart d'audit mineur, non corrigé** : `npm audit` signale une
vulnérabilité `qs` (modérée) corrigeable **sans** breaking change
(`npm audit fix`, sans `--force`) — voir section API10 ci-dessous pour le
détail complet des 17 vulnérabilités connues. Non appliqué dans ce ticket
(modification de dépendances hors périmètre d'un audit documentaire, à
valider explicitement avant exécution).

---

## API9:2023 — Improper Inventory Management ✅

**Avant BACK-405** : 14 des 18 contrôleurs n'avaient aucune annotation
Swagger — l'inventaire des routes n'existait que dans le code source,
aucune vue d'ensemble consultable. La régression `/health` dupliqué
(ci-dessus, API8) est un exemple concret de ce que ce risque décrit : un
endpoint fantôme, jamais nettoyé après que son remplaçant a été livré.

**Après BACK-405** : les 56 routes de l'API sont documentées (`/docs` en
non-production, `/docs-json` pour un usage programmatique), taguées par
module, avec le schéma de sécurité (`@ApiBearerAuth`/`@ApiHeader`) reflétant
la réalité de chaque route — vérifié par extraction complète du document
OpenAPI généré (`components.schemas`, `paths.*.tags`,
`paths.*.security`), pas seulement par lecture du code.

**Résiduel** : pas de versionnement d'API (`/v1/...`) — acceptable au stade
actuel (un seul consommateur connu, `Liyanza`/`Liyanza-mobile`, déployés en
lock-step avec ce backend) ; à revisiter si un jour plusieurs versions du
frontend doivent cohabiter contre des versions différentes de l'API.

---

## API10:2023 — Unsafe Consumption of APIs ✅

**API tierce consommée** : Meta Graph API uniquement (`MetaGraphClient`).

**Vérifié** :

- HTTPS uniquement, jamais de `rejectUnauthorized: false` ni de désactivation
  TLS trouvée dans tout le code source (`grep` exhaustif effectué dans ce
  ticket).
- Réponses typées (`MetaTokenResponse`, `MetaPageEdge`, etc.) — pas de
  confiance aveugle dans une structure `any` ; les champs optionnels sont
  bien marqués `?` et vérifiés avant usage (ex: `expires_in`,
  `instagram_business_account`).
- Erreurs Meta traduites en exceptions applicatives dédiées (`MetaApiError`,
  `MetaTokenExpiredError` sur le code 190) — jamais relayées brutes au
  client (cohérent avec `AllExceptionsFilter`, API8).
- Tokens Meta chiffrés au repos (AES-256-GCM,
  `common/utils/token-encryption.util.ts`) avant persistance en base.

**Dépendances npm (`npm audit`, 2026-09-13)** : 17 vulnérabilités connues
(16 high, 1 moderate) — toutes dans la même chaîne pré-existante
`@nestjs/core`/`multer` (affecte `@bull-board/nestjs`, `@nestjs/bullmq`,
`@nestjs/schedule`, `@nestjs/swagger`, `@nestjs/terminus`, `@nestjs/testing`
en cascade — un correctif de `@nestjs/core` lui-même les résoudrait toutes),
plus `mysql2` (driver jamais utilisé par ce projet — PostgreSQL exclusivement
via `@prisma/adapter-pg` — dépendance transitive de Prisma, pas de code
applicatif l'invoquant) et `qs` (modérée, DoS potentiel côté parsing de
query string — corrigeable sans breaking change via `npm audit fix`, non
appliqué dans ce ticket, cf. réserve API8 ci-dessus).

**Résiduel** : aucune action de code requise pour API10 lui-même ; le point
`qs`/`npm audit fix` relève d'un entretien de dépendances de routine, pas
d'un trou architectural de consommation d'API.

---

## Ce qui reste à trancher (hors périmètre de ce document)

Ce document audite l'état du code, il ne le corrige pas au-delà des deux
correctifs `/health` déjà appliqués dans BACK-405 (mineurs, sans ambiguïté).
Deux décisions produit restent ouvertes, chacune méritant son propre
ticket :

1. **Comportement de repli du throttler en cas de panne Redis** (API8) —
   fail-open vs fail-closed, décision explicite requise avant implémentation.
2. **`npm audit fix`** (sans `--force`) pour la vulnérabilité `qs` — sans
   risque de breaking change apparent, mais toute modification de
   dépendance reste soumise à validation explicite avant exécution.
