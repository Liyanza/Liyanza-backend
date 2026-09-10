# Architecture — Contrat IA (`Liyanza-backend` ↔ `Liyanza-ia`)

Ce document existe pour respecter la frontière IA décrite dans `CLAUDE.md` §2
et `.claude/skills/liyanza-ia-boundary/SKILL.md` : toute évolution du contrat
entre ce repo (NestJS, mocké) et le futur service d'inférence réel doit être
documentée ici, pour que l'équipe travaillant sur `Liyanza-ia` en soit
informée sans avoir à relire l'historique de commits.

**Analyse réalisée le 2026-09-10**, à partir du dépôt public
`https://github.com/Liyanza/Chatbot` (cloné en lecture seule pour l'analyse,
non intégré à ce repo).

---

## 1. État réel du dépôt `Liyanza-ia` analysé

Le dépôt contient en réalité **deux modules indépendants**, à des stades de
maturité très différents :

### 1.1 Simulation de campagne (fonctionnalité 4.4) — proche d'être intégrable

- **Déjà une API HTTP** : FastAPI (`scripts/simulation/simulation_api.py`),
  Dockerisée (`Dockerfile` + `docker-compose.yml`), écoute sur le port 8001.
- Deux endpoints : `POST /simulate/quick` (prédiction XGBoost pure, pas de
  LLM, rapide) et `POST /simulate/full` (idem + texte généré par LLM local).
- Modèles déjà entraînés (XGBoost via scikit-learn/MLflow), chargés au
  démarrage (`lifespan`), artefacts dans `models/simulation/`.
- `requirements-api.txt` est déjà **correctement curaté** (fastapi, uvicorn,
  pandas, scikit-learn, xgboost, joblib, requests — rien de plus).

### 1.2 Assistant IA « Poser une question » — au stade script, pas encore une API

- **`scripts/chatbot/06_chatbot.py` est un script REPL en ligne de commande**
  (boucle `input()`/`print()` dans un terminal), pas un service HTTP. C'est
  le point le plus important à comprendre avant d'intégrer quoi que ce soit :
  il n'y a aujourd'hui **rien à appeler depuis le backend**, il faut d'abord
  l'envelopper dans une API.
- Combine trois briques, chacune réutilisable (`llm_client.py`,
  `rag_retrieve.py`, `text_to_sql.py`) :
  1. **LLM** : Ollama en local (`llama3.2`), appelé via `requests` sur
     `http://localhost:11434/api/chat`. Gratuit, pas de clé API, mais
     nécessite qu'Ollama tourne en continu avec le modèle chargé en mémoire.
  2. **RAG** : ChromaDB persistant (`output/chroma_db/`, fichier local) +
     embeddings `sentence-transformers`
     (`paraphrase-multilingual-mpnet-base-v2`, ~470 Mo). Corpus = 2 PDF
     statiques (document de cadrage + cahier des charges IA) — une base de
     connaissance **produit**, commune à toutes les entreprises, pas de
     donnée client dedans.
  3. **Text-to-SQL** : le LLM traduit la question en `SELECT` (validé par
     une liste noire de mots-clés interdits), exécuté sur une table
     PostgreSQL `campaigns` **indépendante**, chargée depuis un fichier
     Excel synthétique de 20 000 lignes fictives
     (`scripts/chatbot/02_load_excel_to_postgres.py`). Aucun lien avec la
     base Prisma de ce repo.
- Le système de prompt (`scripts/chatbot/system_prompt.md`) est déjà rédigé
  avec soin à partir du cahier des charges IA, et anticipe correctement des
  exigences que le code n'implémente pas encore (voir §2.2 et §2.4).

---

## 2. Écarts trouvés (analyse comparative avec ce repo)

### 2.1 Aucune API HTTP pour l'assistant question/réponse — bloquant

Avant toute intégration, `06_chatbot.py` doit être enveloppé dans une API
FastAPI, sur le modèle exact de `simulation_api.py` (déjà fait pour la
simulation). Rien d'autre n'est possible tant que cette étape n'existe pas.

### 2.2 Écart entre l'intention du system prompt et le code réel (multi-tenant)

`system_prompt.md` énonce explicitement : _« N'utilise JAMAIS les données
d'une autre entreprise »_ et _« Si le profil de l'entreprise est
disponible... adapte »_ — mais **aucun mécanisme de scoping par entreprise
n'existe dans le code Python actuel** :

- Le RAG (corpus produit commun) ne pose pas de risque réel aujourd'hui —
  aucune donnée client dedans.
- Le text-to-SQL, lui, interroge une table `campaigns` **unique et
  fictive**, sans colonne `company_id`. Ce n'est **pas un risque de fuite
  aujourd'hui** (données synthétiques partagées par construction), mais
  cette couche ne peut **pas être branchée telle quelle** sur de vraies
  données confidentielles — voir la recommandation au §4.5.

### 2.3 Aucune authentification sur l'API existante

`simulation_api.py` déclare `CORSMiddleware(allow_origins=["*"])` et
n'a **aucune vérification d'appelant** (pas de clé API, pas de secret
partagé). N'importe qui connaissant l'URL peut consommer les endpoints
(coût CPU/Ollama). Le même écueil serait trivial à reproduire sur le futur
endpoint de chat si on ne s'en préoccupe pas dès le départ.

### 2.4 Contrat `askQuestion` actuel (ce repo) trop pauvre pour ce que Python attend

```ts
// src/modules/assistant-ia/clients/ia-engine.interface.ts (existant)
export interface AskQuestionParams {
  conversationId: string;
  userMessage: string;
  context?: Record<string, any>;
}
```

Et dans `assistant-ia.service.ts`, `envoyerMessage()` n'envoie aujourd'hui
que `context: { topic: conversation.topic }` — ni l'historique de la
conversation, ni le profil de l'entreprise (secteur, etc.), ni aucune
donnée de campagne réelle. Le system prompt Python attend justement ce
contexte pour « adapter » sa réponse — actuellement transmis à vide. Voir
proposition d'extension au §4.2.

### 2.5 Hébergement d'Ollama = un service à faire tourner en continu

Contrairement à la simulation (modèles XGBoost chargés en mémoire, légers),
le chat dépend d'un LLM qui doit rester chargé (Ollama, `keep_alive: 30m`).
Ce n'est pas un script qu'on lance à la demande : c'est un service
qu'il faut héberger 24/7 quelque part. Voir §3.

### 2.6 Poids du RAG (ChromaDB + sentence-transformers) et hygiène des dépendances

`requirements.txt` (racine du dépôt IA) est un **`pip freeze` brut de
l'environnement de dev local** — il contient des paquets sans rapport avec
le projet (`docker`, `databricks-sdk`, `GitPython`, `Flask`...). Pas fiable
pour la reproductibilité d'un build. À l'inverse, `requirements-api.txt`
(simulation) est déjà correctement curaté — le futur `requirements-chatbot.txt`
devrait suivre le même principe.

### 2.7 `mlruns/` committé dans le dépôt

Artefacts de tracking MLflow (chemins absolus locaux
`C:/Users/LOIC/Desktop/kiyanza_chatbot/...` visibles dans les fichiers
`MLmodel`), non utilisés au runtime de l'API (le `Dockerfile` ne copie que
`models/simulation/`). Alourdit le dépôt sans utilité de déploiement.

### 2.8 Contrat de simulation également en écart (secondaire, hors périmètre demandé)

`simulate_full` renvoie `{predictions: dict, explanations: dict, warnings: list[str], text: str}`
(4 métriques : reach, engagement_rate, ctr, roas + facteurs explicatifs),
bien plus riche que le contrat mock actuel
(`SimulationResult = {estimatedBudget, expectedResults}`). Le formulaire
NestJS (`SoumettreReponsesDto`, questionnaire libre `{questionId, value}[]`)
ne correspond pas non plus aux 15 champs catégoriels attendus par le modèle
XGBoost (`industry`, `company_size`, `city`, `platform`..., voir
`data/simulation/feature_schema.json`). Signalé pour mémoire — non traité
ici, le périmètre demandé porte sur l'assistant question/réponse.

---

## 3. Hébergement — ce qui est possible autour de Render

**Le LLM (Ollama) est le point dur.** Deux options réalistes :

| Option                                                               | Description                                                                                                                                     | Avantage                                                                                     | Inconvénient                                                                                                                                                                      |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Ollama auto-hébergé**                                           | Un service Render dédié (Private Service ou Background Worker) avec assez de RAM (4-8 Go conseillés pour `llama3.2` 3B), tournant en continu    | Gratuit à l'usage, aucune donnée envoyée à un tiers                                          | Coût d'infra fixe (RAM dédiée en continu), latence CPU (pas de GPU sur les plans Render standards), maintenance                                                                   |
| **B. LLM hébergé via API** (Groq, Mistral API, OpenAI, Anthropic...) | `llm_client.py` adapté pour appeler une API HTTP externe au lieu d'Ollama local — **aucun changement du system prompt ni de la logique métier** | Pas d'infra à maintenir, souvent plus rapide, certains (Groq) ont un palier gratuit généreux | Coût par requête à un tiers, dépendance externe — **mais c'est explicitement permis dans `Liyanza-ia`** (contrairement à ce repo NestJS) : c'est justement le rôle du repo séparé |

C'est une décision produit/coût, pas une décision technique que je peux
trancher à votre place.

**Le reste s'héberge sans difficulté particulière** :

- Le FastAPI (chat + simulation) tourne en Docker sur un Web Service Render
  standard, comme ce backend NestJS.
- **ChromaDB** (`output/chroma_db/`, fichier local persistant) ne survit pas
  à un redeploy Render sans disque persistant dédié (add-on payant). Deux
  choix : (a) un Render Persistent Disk, ou (b) **migrer vers `pgvector`**
  dans le PostgreSQL déjà managé par ce projet — recommandé, ça réutilise
  une infra déjà payée/administrée plutôt que d'en ajouter une nouvelle.
- La table `campaigns` synthétique n'a pas vocation à être hébergée telle
  quelle en production — voir §4.5.

---

## 4. Modifications proposées (périmètre : assistant « poser une question »)

### 4.1 Empaqueter le chatbot en API FastAPI (symétrique à `simulation_api.py`)

```
POST /ask
{
  "conversationId": "...",
  "userMessage": "...",
  "context": { "topic": "...", "companyProfile": {...}, "recentMessages": [...] }
}
→ { "answer": "..." }
```

- Authentification par secret partagé (`X-Internal-Token`), même mécanisme
  que `InternalTokenGuard` déjà en place côté NestJS pour BACK-304 (webhook
  monitoring) — comparaison en temps constant, jamais de JWT utilisateur
  puisque seul ce backend appelle cette API, jamais un navigateur.
- `CORSMiddleware(allow_origins=["*"])` à retirer dès que ce secret existe :
  seul le backend NestJS doit pouvoir appeler cette route, jamais un client
  public.

### 4.2 Étendre `AskQuestionParams` (ce repo) pour transmettre le contexte réellement utile

```ts
export interface AskQuestionParams {
  conversationId: string;
  userMessage: string;
  context?: {
    topic?: string;
    companyProfile?: { name: string; businessSector: string; address: string };
    recentMessages?: { sender: 'USER' | 'AI'; content: string }[];
  };
}
```

`AssistantIService.envoyerMessage()` devra charger `company` (déjà
accessible via `conversation.companyId`) et les derniers messages de la
conversation (déjà en base, `AiMessage`) pour peupler ce contexte avant
l'appel — aucun nouveau champ Prisma requis, tout existe déjà en base.
Mettre à jour `IAEngineMock` en conséquence pour que le contrat reste
vérifiable en test tant que le vrai client n'existe pas.

### 4.3 Nouveau client HTTP, à créer **seulement** quand l'API Python existe réellement

`src/modules/assistant-ia/clients/ia-engine.http-client.ts` implémentant
`IAEngineInterface`, appelant `POST {IA_SERVICE_URL}/ask` avec le header
interne. Bascule dans `assistant-ia.module.ts` :
`{ provide: IA_ENGINE_TOKEN, useClass: IAEngineHttpClient }` (au lieu du
mock) — un changement d'une seule ligne, comme prévu par le découplage
existant.

### 4.4 Nouvelles variables d'environnement (à ajouter seulement au moment du branchement réel)

`IA_SERVICE_URL`, `IA_SERVICE_INTERNAL_TOKEN` dans `env.validation.ts`,
même rigueur que `INTERNAL_MONITORING_TOKEN` (longueur minimale, rejet des
valeurs placeholder). **Ne pas les ajouter avant que le vrai client
existe** : des variables `@IsDefined()` non renseignées casseraient le
démarrage du service actuel (mock) sans aucun bénéfice.

### 4.5 Text-to-SQL : ne jamais le brancher sur les vraies données sans un filtre non contournable

Si un jour ce module interroge les vraies données de campagnes (au lieu du
jeu de données synthétique), le filtre `company_id = ...` doit être **posé
par le code Python lui-même** (jamais laissé au LLM à générer dans la
requête SQL) — même principe que celui déjà appliqué dans ce repo pour les
redirections QR code : ne jamais confier une décision de sécurité au
composant le moins fiable de la chaîne. Concrètement : soit le LLM ne
génère qu'un filtre WHERE sur des colonnes non sensibles et le code Python
ajoute systématiquement `AND company_id = :company_id`, soit — plus robuste
— le texte-à-SQL interroge une **vue restreinte** déjà scopée par
entreprise, jamais la table brute. Alternative plus simple et plus sûre :
plutôt qu'un accès direct à la base, **exposer un endpoint interne
NestJS** (même pattern que `POST /internal/monitoring/detections`,
BACK-304) que Liyanza-ia appelle avec le `companyId` déjà validé
côté NestJS — Liyanza-ia n'a alors jamais d'accès direct à la base de
production.

### 4.6 RAG : migrer vers `pgvector` (recommandé, pas bloquant)

Le corpus (documentation produit, pas de données client) peut rester tel
quel fonctionnellement — seul le stockage change, de ChromaDB fichier
local vers une extension `pgvector` dans le PostgreSQL déjà managé par ce
projet, pour survivre aux redeploys Render sans disque persistant
supplémentaire.

---

## 5. Guide d'intégration — étapes dans l'ordre

1. **Côté `Liyanza-ia`** : créer `scripts/chatbot/chatbot_api.py` (FastAPI,
   endpoint `POST /ask`, garde `X-Internal-Token`), Dockerfile dédié
   (`requirements-chatbot.txt` curaté, séparé de `requirements-api.txt`),
   trancher Ollama auto-hébergé vs LLM hébergé (§3).
2. **Décider l'hébergement du LLM** (option A ou B, §3) — nécessaire avant
   l'étape 1 en pratique, car `llm_client.py` en dépend directement.
3. **Côté ce repo (`Liyanza-backend`)** : étendre `AskQuestionParams` +
   `IAEngineMock` (§4.2) — indépendant du reste, peut se faire dès
   maintenant, sans attendre que Python soit prêt.
4. **Une fois l'API Python déployée et joignable** : créer
   `IAEngineHttpClient` (§4.3), ajouter `IA_SERVICE_URL`/
   `IA_SERVICE_INTERNAL_TOKEN` (§4.4), basculer le binding dans
   `assistant-ia.module.ts`.
5. **Migration RAG vers pgvector** (§4.6) et **retrait de `mlruns/`
   /nettoyage `requirements.txt`** (§2.6-2.7) — améliorations, non
   bloquantes, à faire quand le temps le permet.
6. Le text-to-SQL (§4.5) reste sur le jeu de données synthétique tant
   qu'aucune décision n'est prise sur le mécanisme de scoping — ne pas le
   brancher sur les vraies données avant que ce point soit tranché
   explicitement.

**Ordre recommandé** : 2 → 1 → 3 (peut être fait en parallèle de 1-2) → 4 →
5/6 en continu.

---

## 6. Contrat IA — Simulation digitale (BACK-501/502/503/504)

**Ajouté le 2026-09-10**, à l'occasion de la refonte du module de campagnes
digitales (Facebook/Instagram) et de l'intégration Meta Graph API. Ce contrat
est **séparé** de celui de la simulation générique existante
(`SimulationEngineInterface`/`SIMULATION_ENGINE_TOKEN`, `SimulationsModule`,
questionnaire libre `Questionnaire`/`Question`) — celui-ci n'est pas modifié
et reste tel quel. La simulation digitale a son propre contrat,
`DigitalSimulationEngineInterface`/`DIGITAL_SIMULATION_ENGINE_TOKEN`
(`src/modules/digital-campaigns/clients/`), branché sur
`DigitalSimulationEngineMock` — **doit rester mocké**, cf. `CLAUDE.md` §2.

### 6.1 Pourquoi un contrat séparé plutôt qu'étendre l'existant

Le §2.8 de ce document notait déjà que le contrat mock générique
(`{estimatedBudget, expectedResults}`) est bien plus pauvre que ce
qu'attend le vrai moteur XGBoost analysé dans `Liyanza-ia`
(`{predictions: {reach, engagement_rate, ctr, roas}, explanations, warnings,
text}`). Plutôt que de réécrire le contrat générique (risque de régresser un
flux déjà testé à 100% et potentiellement utilisé par d'autres types de
campagne), la nouvelle interface `DigitalSimulationEngineInterface` reprend
directement cette forme riche, mais uniquement pour le pipeline Digital.

### 6.2 Contrat (entrée)

```ts
interface DigitalSimulationParameters {
  objective: 'AWARENESS' | 'ENGAGEMENT' | 'CONVERSION';
  budget: { amount: number; allocation: 'TOTAL' | 'DAILY' };
  audience: {
    ageMin: number;
    ageMax: number;
    targetGender: string;
    locations: string[];
    interests: string[];
  };
  channels: {
    platform: 'FACEBOOK' | 'INSTAGRAM';
    // `null` si le canal est sélectionné mais qu'aucun compte Meta n'y est
    // encore lié/synchronisé — le moteur doit dégrader proprement, jamais
    // échouer sur ce cas (déjà géré ainsi côté mock).
    metrics: {
      followerCount?: number;
      reach?: number;
      impressions?: number;
      engagementRate?: number;
      avgCpm?: number;
      avgCpc?: number;
    } | null;
  }[];
}
```

Les métriques, quand présentes, proviennent de la dernière ligne
`PlatformMetric` ingérée pour le `SocialAccount` lié à chaque canal (BACK-503,
ingestion réelle via l'API Graph de Meta — **pas de l'IA**, une simple API de
données sociales, voir `.claude/skills/liyanza-ia-boundary/SKILL.md`).

### 6.3 Contrat (sortie) — forme alignée sur `simulate_full`

```ts
interface DigitalSimulationResult {
  predictedReach: number;
  predictedEngagementRate: number;
  predictedCtr: number;
  predictedRoas: number;
  narrativeSummary: string;
  warnings: string[];
}
```

Persisté tel quel dans le nouveau modèle `DigitalSimulation` (voir
`prisma/schema.prisma`). Objectif explicite : le jour où `Liyanza-ia` expose
un vrai `POST /simulate/digital` (ou équivalent), le branchement doit se
limiter à créer `DigitalSimulationEngineHttpClient implements
DigitalSimulationEngineInterface` et changer le `provide:
DIGITAL_SIMULATION_ENGINE_TOKEN` dans `DigitalCampaignsModule` — **aucune
migration Prisma, aucun changement de DTO côté mobile**.

### 6.4 Ce qui reste hors périmètre de ce repo

- Le calcul de la prédiction elle-même (`DigitalSimulationEngineMock` génère
  des valeurs pseudo-aléatoires dans la bonne forme, jamais une vraie
  inférence).
- Toute logique de machine learning sur les métriques Meta ingérées.

Ce qui est réellement implémenté dans ce repo (pas de l'IA) : l'OAuth Meta,
le chiffrement/stockage des tokens, l'appel à l'API Graph pour ingérer les
métriques réelles (`SocialAccountsModule`, BACK-502/503), et toute
l'orchestration NestJS autour de l'appel au moteur mocké (validation,
persistance, RBAC, gestion d'erreur) — voir `docs/BACKLOG_REORIENTE.md`,
section « Phase 5 ».
