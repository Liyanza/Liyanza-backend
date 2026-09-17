# Canevas d'intégration — `Kidata.2` (simulation & prescription de campagne)

**Écrit pour** : l'équipe IA travaillant sur `Kidata.2`.
**Écrit par** : Claude Code, côté `Liyanza-backend`, à partir d'une lecture
complète du dépôt (clone en lecture seule, 2026-09-14) et du contrat réel
implémenté aujourd'hui côté NestJS pour les campagnes digitales
(BACK-501/502/503/504).
**Objectif de ce document** : dire précisément ce qu'il reste à faire pour
héberger ce service, et lister les écarts de contrat à trancher ensemble
avant le branchement réel — ce n'est pas à vous de deviner ce qu'attend le
backend, ni à moi de deviner votre logique métier : ce document sert de
point de rencontre explicite.

---

## 0. Ce qui est déjà très bien fait

Architecture propre (`api/`, `core/`, `models/`, `schemas/`, `services/`),
schémas Pydantic v2 stricts avec validations métier réelles (`age_range`
bornée 13-85, `total_budget_fcfa > 0`...), logique découpée en modules
responsables chacun d'une chose (`budget_allocator.py`,
`metrics_estimator.py`, `formatter.py`), et surtout — rare à ce stade d'un
projet — **des tests unitaires déjà écrits**
(`app/tests/unit/test_budget_allocator.py`,
`test_simulation_engine.py`). L'approche (priors sectoriels/géographiques
calibrés plutôt qu'un modèle ML entraîné sur données synthétiques) est
défendable et plus explicable pour un commerçant qui doit comprendre
pourquoi on lui recommande telle allocation.

**Aucune remarque sur la logique métier elle-même** (`budget_allocator.py`,
`metrics_estimator.py`) — ce document ne porte que sur le contrat
d'intégration et l'hébergement, pas sur les formules.

---

## 1. Ce qui manque avant de pouvoir héberger ce service

Contrairement à ce que le README pourrait laisser penser, **ce repo n'est
pas encore un service exécutable** :

- **Aucun point d'entrée FastAPI n'existe.** `app/api/v1/router.py`
  définit un `APIRouter`, mais nulle part un `app = FastAPI()` n'est créé
  ni ce router monté (`app.include_router(...)`). Il manque un
  `app/main.py` (ou équivalent) qui : instancie `FastAPI()`, monte
  `api_router` sous `settings.API_V1_STR`, configure `CORSMiddleware`
  avec la liste de `settings.BACKEND_CORS_ORIGINS` (déjà définie dans
  `core/config.py`, juste jamais utilisée), expose `GET /health`.
- **Aucun fichier de dépendances** (`requirements.txt`/`pyproject.toml`)
  n'existe dans le dépôt — seule la liste en prose du README permet de
  savoir quoi installer. Nécessaire pour tout build reproductible/Docker.
- **Aucun `Dockerfile`.**
- **Aucune authentification** sur `POST /api/v1/campaigns/simulate` — voir
  §4, même mécanisme que pour l'autre service IA (`kiyanza_assistant_ia`).

Rien de bloquant techniquement — c'est un service FastAPI classique, la
logique métier (la partie difficile) est déjà faite.

---

## 2. ⚠️ Ne pas connecter ce service à la base de données `liyanza_db`

`app/core/config.py` définit par défaut
`DATABASE_URL: postgresql+asyncpg://postgres:postgres@localhost:5432/liyanza_db`,
et `app/models/campaign_ai.py`/`deps.py` mettent en place une session
SQLAlchemy async — mais **l'endpoint `simulate_campaign` actuel ne s'en
sert pas** (aucune injection de `get_database_session` dans
`endpoints/simulation.py`). Cette base de code existe mais n'est pas
câblée à ce jour.

**Recommandation forte avant de la câbler** : ne donnez pas à ce service
un accès direct à la base PostgreSQL de production de `Liyanza-backend`.
Trois raisons concrètes :

1. **Le service se décrit lui-même comme "stateless"** (README §1) — un
   accès DB direct contredit ce principe de conception, pas juste une
   question de sécurité.
2. **Incompatibilité de type déjà présente dans le code** :
   `CampaignAI.tenant_id` est typé `UUID` (`sqlalchemy.dialects.postgresql.UUID`).
   Nos identifiants d'entreprise (`Company.id`, tout comme tous les autres
   ids du schéma Prisma) sont des **cuid** — des chaînes du type
   `cjld2cjxh0000qzrmn831i7rn`, **pas** des UUID. Si ce modèle est un jour
   alimenté avec un vrai `companyId` Liyanza, l'insertion échouera (ou,
   pire, sera silencieusement tronquée/mal interprétée selon le driver).
   Si vous gardez ce modèle pour un usage interne (logs de calibration),
   changez `tenant_id` en `String`, jamais en `UUID`.
3. **Séparation des responsabilités** : `Liyanza-backend` est la seule
   source de vérité sur qui a le droit de voir/modifier quoi
   (isolation multi-tenant, rôles). Un accès direct à la base depuis ce
   service contournerait tous ces contrôles.

**Pattern recommandé** (déjà celui utilisé pour la simulation mockée
aujourd'hui, `DigitalSimulationEngineMock`) : ce service reste stateless,
NestJS lui envoie tout ce qu'il faut dans la requête, reçoit le résultat, et
c'est **NestJS qui persiste** le résultat dans sa propre base
(`DigitalSimulation`). Si vous avez besoin de conserver un historique
brut pour calibrer/améliorer le modèle plus tard (`actual_metrics` dans
`CampaignAI` suggère cette intention), gardez cette persistance dans **votre
propre base de données**, séparée de `liyanza_db` — jamais la même
instance, jamais les mêmes tables.

---

## 3. Écart de contrat avec ce qu'envoie réellement NestJS aujourd'hui

Ce qui suit est le contrat **actuellement implémenté** côté NestJS
(`DigitalCampaignDetails`/`DigitalCampaignChannel` en base, alimentés par
le wizard de campagne digitale, BACK-501). Il diverge significativement de
`SimulationInputSchema`. Aucun des deux contrats n'est "le bon" par
défaut — c'est une décision à prendre ensemble.

| Donnée                                          | Côté NestJS (aujourd'hui)                                                                                                                | Côté `Kidata.2` (`SimulationInputSchema`)                          |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Budget                                          | `Campaign.plannedBudget: Decimal` + `budgetAllocation: TOTAL\|DAILY` (pas de champ devise explicite, FCFA implicite via le marché cible) | `total_budget_fcfa: float` (devise explicite dans le nom du champ) |
| Objectif                                        | `DigitalObjective`: `AWARENESS \| ENGAGEMENT \| CONVERSION`                                                                              | `ObjectiveEnum`: `sales \| leads \| awareness`                     |
| Âge cible                                       | `ageMin: Int`, `ageMax: Int`                                                                                                             | `age_range: str` (format `"MIN-MAX"`)                              |
| Genre                                           | `targetGender: string` (`"ALL"\|"MALE"\|"FEMALE"`, aligné sur Meta Ads)                                                                  | `gender: GenderEnum` (`all\|women\|men`)                           |
| Zone géographique                               | `targetLocations: String[]` (liste, ex: plusieurs quartiers/villes)                                                                      | `target_zone: str` (une seule ville)                               |
| Centres d'intérêt                               | `targetInterests: String[]`                                                                                                              | `interests: List[str]` (même idée)                                 |
| Canaux                                          | `DigitalCampaignChannel.platform`: `FACEBOOK \| INSTAGRAM` uniquement (enum `SocialPlatform`) — **pas de WhatsApp**                      | Meta Ads + **Click-to-WhatsApp** comme canal de première classe    |
| Métriques d'audience existante                  | `PlatformMetric.followerCount` (Facebook/Instagram, ingéré réellement via Meta Graph API, BACK-503)                                      | `facebook_followers: int`, `whatsapp_contacts: int`                |
| Durée                                           | Dérivable de `Campaign.startDate`/`endDate`, jamais transmis en jours explicitement                                                      | `duration_days: int`                                               |
| Panier moyen / capacité de traitement des leads | **Aucun équivalent** — non collecté aujourd'hui                                                                                          | `average_basket_fcfa`, `daily_lead_capacity` — requis              |

**Sortie attendue par NestJS aujourd'hui** (`DigitalSimulation`, très
pauvre en comparaison) :

```
{ predictedReach, predictedEngagementRate, predictedCtr, predictedRoas, narrativeSummary, warnings[] }
```

**Sortie que produit `Kidata.2`** (`SimulationResponseSchema`, bien plus
riche : allocation budgétaire par canal, créneaux horaires recommandés,
formats créatifs recommandés, projections de ventes/CA en FCFA, CAC,
détection de goulot d'étranglement opérationnel, score de confiance).

### Ce qu'il faut décider ensemble avant de figer un contrat définitif

Je ne peux pas trancher ces points à votre place (logique métier +
produit) :

1. **WhatsApp devient-il un canal de campagne digitale à part entière**
   côté Liyanza (au même titre que Facebook/Instagram) ? Si oui, il faudra
   l'ajouter à l'enum `SocialPlatform` et prévoir COMMENT le nombre de
   contacts WhatsApp est obtenu (il n'y a aujourd'hui aucune intégration
   OAuth WhatsApp Business dans `Liyanza-backend` — ce serait un nouveau
   chantier, pas un simple champ de formulaire).
2. **`average_basket_fcfa` et `daily_lead_capacity` sont-ils des champs à
   ajouter au formulaire de création de campagne digitale** (nouvelle
   étape du wizard) ? Ce sont des données métier réelles (panier moyen,
   capacité de l'équipe) que Liyanza ne demande pas aujourd'hui.
3. **`target_zone` (une ville) vs `targetLocations` (une liste)** — lequel
   des deux modèles reflète le mieux un usage réel ? Une seule zone
   simplifie votre modèle de calibration (CPM par ville) ; une liste est
   plus flexible côté produit mais complique le calibrage.
4. **FCFA comme hypothèse de devise assumée** (plutôt qu'un champ devise
   générique) — cohérent avec le marché cible actuel (Cameroun), à
   confirmer explicitement plutôt que supposé implicitement.
5. **Le format de sortie riche de `Kidata.2` sera-t-il repris tel quel ?**
   Si oui, `DigitalSimulation` (schéma Prisma) devra être étendu
   (nouvelles colonnes ou un champ JSON pour la prescription complète) —
   travail côté NestJS, actuellement en pause, à reprendre une fois ces
   points tranchés.

**Ma recommandation** si vous n'avez pas de contrainte contraire : gardez
votre contrat `SimulationInputSchema`/`SimulationResponseSchema` tel quel
côté Python (il est cohérent et déjà testé) — c'est plus simple pour NestJS
d'évoluer son formulaire pour vous envoyer ce qu'il vous faut, que pour
vous de dégrader un moteur déjà calibré pour rentrer dans un contrat plus
pauvre. Dites-moi simplement, une fois ce document lu, si cette direction
vous convient, pour que je sache ce qu'il faut faire évoluer côté NestJS.

---

## 4. Authentification — même mécanisme que pour le chatbot

Identique au canevas du chatbot (`docs/canevas-ia-chatbot.md` §4) : secret
partagé `X-Internal-Token`, comparaison à temps constant
(`hmac.compare_digest`), jamais de `CORSMiddleware(allow_origins=["*"])`.
Réutilisez le même code de dépendance FastAPI dans les deux services si
c'est plus simple pour vous — le secret lui-même (`INTERNAL_TOKEN`) peut
être différent par service, ce sera deux variables d'environnement
distinctes côté NestJS (`IA_CHATBOT_INTERNAL_TOKEN`,
`IA_SIMULATION_INTERNAL_TOKEN` par exemple).

---

## 5. Sort du second moteur de simulation (`kiyanza_assistant_ia`)

`kiyanza_assistant_ia/scripts/simulation/` contient un moteur DIFFÉRENT
(XGBoost entraîné sur 20 000 lignes synthétiques), déjà exposé via
`simulation_api.py` avec plusieurs endpoints (`/simulate/quick`,
`/simulate/full`, `/simulate/recommendations`, `/simulate/multi-platform`,
`/campaigns/{id}/plan`). Voir `docs/canevas-ia-chatbot.md` §0.

**Question ouverte, à trancher en équipe** : `Kidata.2` remplace-t-il ce
moteur, ou les deux approches doivent-elles coexister pour des besoins
différents ? Si `Kidata.2` remplace l'ancien moteur, les fonctionnalités
`/simulate/recommendations` (ajustement de campagne déjà lancée) et
`/campaigns/{id}/plan` (plan de communication) de l'ancien moteur
n'ont-elles pas d'équivalent prévu ici ? À vérifier avant de supprimer
l'ancien moteur, pour ne pas perdre une capacité déjà construite.

---

## 6. Definition of Done pour ce ticket

- [ ] `app/main.py` créé : instancie `FastAPI()`, monte `api_router`,
      configure CORS depuis `settings.BACKEND_CORS_ORIGINS` (retirer
      `http://localhost:3000`/`:8000` de la liste par défaut en
      production — ne garder que l'origine réelle du frontend si un appel
      navigateur direct est un jour nécessaire ; **ce n'est pas le cas
      aujourd'hui**, seul `Liyanza-backend` doit appeler ce service).
- [ ] `GET /health` disponible.
- [ ] Authentification `X-Internal-Token` sur `POST /api/v1/campaigns/simulate`.
- [ ] Aucune connexion à `liyanza_db` — si la persistance `CampaignAI` est
      conservée, elle pointe vers une base **séparée**, et `tenant_id`
      redevient une chaîne si un jour un `companyId` Liyanza y est stocké.
- [ ] `requirements.txt` ou `pyproject.toml` créé (dépendances déjà
      listées dans le README §5, à figer dans un fichier).
- [ ] `Dockerfile` fonctionnel, testé localement.
- [ ] Décisions du §3 tranchées et communiquées (même si le contrat
      définitif n'est pas encore implémenté côté NestJS).
- [ ] Service hébergé et accessible.

## 7. Ce qu'il faut me communiquer une fois hébergé

Identique au canevas chatbot (§8 de `docs/canevas-ia-chatbot.md`) :

1. URL publique du service.
2. Méthode d'hébergement utilisée.
3. Valeur du secret `INTERNAL_TOKEN` (canal sécurisé, jamais en clair).
4. Confirmation `GET /health` → 200.
5. Vos réponses aux 5 points de décision du §3 — c'est ce qui me permet de
   reprendre le travail côté NestJS (extension de `DigitalCampaignDetails`,
   du formulaire de campagne digitale, et de `DigitalSimulation`) sur des
   bases certaines plutôt que sur une supposition.
