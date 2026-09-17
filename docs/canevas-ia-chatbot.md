# Canevas d'intégration — `kiyanza_assistant_ia` (chatbot marketing)

**Écrit pour** : l'équipe IA travaillant sur `kiyanza_assistant_ia`.
**Écrit par** : Claude Code, côté `Liyanza-backend`, à partir d'une lecture
complète du dépôt (clone en lecture seule, 2026-09-14) et du contrat réel
attendu aujourd'hui par le backend NestJS.
**Objectif de ce document** : dire précisément ce qu'il reste à faire pour
que ce service soit appelable en production, sans réécrire ce qui
fonctionne déjà bien.

---

## 0. Périmètre : ce repo, c'est le chatbot conversationnel — plus rien d'autre

Suite à la décision de séparer l'IA "chatbot" de l'IA "fonctionnalités de
l'app" (simulation de campagne), **ce dépôt doit se recentrer sur
`scripts/chatbot/`** (RAG + text-to-SQL + LLM, mode "Poser une question").

Le contenu de `scripts/simulation/` (moteur XGBoost, `simulation_api.py`,
`run_api.py`) est **en doublon fonctionnel avec le second repo,
`Kidata.2`**, qui implémente une approche différente (règles/priors métier
plutôt que ML sur données synthétiques) pour le même besoin. Voir
`docs/canevas-ia-simulation.md` pour le détail. **Question à trancher en
équipe, pas par moi** : lequel des deux moteurs de simulation continue
d'exister ? Si `Kidata.2` est retenu, `scripts/simulation/`,
`models/simulation/`, `data/simulation/`, `mlruns/`, `mlflow.db` et
`run_api.py` peuvent être supprimés de ce dépôt une fois la migration
confirmée — pas avant.

---

## 1. Ce qui est déjà très bien fait — ne pas retoucher

`scripts/chatbot/system_prompt.md` est un excellent system prompt : ton
d'expert marketing, adaptation au contexte de l'entreprise, règle de
confidentialité inter-entreprises explicite, gestion des salutations,
anti-circularité (interdiction de ne renvoyer QUE vers une fonctionnalité
Kiyanza sans contenu réel), avertissement sur les sujets juridiques/fiscaux,
adaptation aux réalités des marchés émergents (budgets limités,
connectivité instable). **Rien à changer ici.** Le seul point qui manque
n'est pas dans le prompt, il est dans la tuyauterie autour (§2-3 ci-dessous).

`scripts/chatbot/llm_client.py`, `rag_retrieve.py`, `text_to_sql.py` sont
des modules propres et réutilisables (sécurité déjà intégrée dans
`text_to_sql.py` : seules les requêtes `SELECT` passent, tout le reste est
rejeté avant exécution). Bonne base.

---

## 2. Le seul vrai bloquant : il n'existe aucune API HTTP pour ce chatbot

`scripts/chatbot/06_chatbot.py` est une boucle `input()`/`print()` dans un
terminal. **Rien dans ce dépôt ne peut être appelé par le backend
aujourd'hui.** Tout le reste de ce document ne sert à rien tant que cette
étape n'est pas faite.

**À faire** : envelopper la logique de `06_chatbot.py` dans une API FastAPI,
sur le modèle exact de ce qui existe déjà pour la simulation
(`scripts/simulation/simulation_api.py`) — même structure, mêmes outils
(FastAPI + uvicorn), juste un contrat différent (§3 ci-dessous).

---

## 3. Contrat HTTP exact attendu par le backend

Voici EXACTEMENT ce que `Liyanza-backend` envoie aujourd'hui (le type
`AskQuestionParams` de
`src/modules/assistant-ia/clients/ia-engine.interface.ts`, actuellement
branché sur un mock — c'est ce mock que votre API doit remplacer) :

```
POST /ask
Content-Type: application/json
X-Internal-Token: <secret partagé, voir §4>

{
  "conversationId": "cjld2cjxh0000qzrmn831i7rn",
  "userMessage": "Quel réseau social est le plus adapté à mon secteur ?",
  "context": {
    "topic": "Choix des canaux",
    "companyProfile": {
      "name": "Kiyanza Demo SARL",
      "businessSector": "Agroalimentaire",
      "address": "Akwa, Douala, Cameroun"
    },
    "recentMessages": [
      { "sender": "USER", "content": "Bonjour" },
      { "sender": "AI", "content": "Bonjour ! Comment puis-je vous aider ?" }
    ]
  }
}
```

Réponse attendue :

```json
{ "answer": "Le texte de la réponse, en français." }
```

**Notes importantes sur ce contrat** :

- `context.companyProfile` et `context.recentMessages` sont **optionnels**
  (absents si la conversation vient d'être créée, ou si l'entreprise de
  l'utilisateur n'existe pas encore) — votre code doit gérer leur absence
  sans planter, exactement comme le prompt gère déjà "si le profil de
  l'entreprise est disponible, adapte... sinon reste générique".
- `recentMessages` sera une fenêtre bornée (les derniers échanges, pas tout
  l'historique) — pas besoin de gérer une conversation de 500 messages côté
  Python, le backend ne vous en envoie jamais autant.
- `companyProfile`/`recentMessages` appartiennent **toujours** à la MÊME
  entreprise que celle de l'appelant — le backend ne vous enverra jamais le
  profil ou l'historique d'une autre entreprise. Votre système, lui, n'a
  strictement rien à faire pour garantir cette isolation : elle est déjà
  garantie côté NestJS avant que la requête ne vous arrive. Ne construisez
  jamais de logique qui accepterait un `companyId` fourni séparément dans
  la requête pour aller chercher plus de données — vous ne recevez que ce
  qui vous est explicitement transmis, un point c'est tout.
- ⚠️ **Ce contrat n'est pas encore branché côté NestJS aujourd'hui** — le
  mock actuel n'envoie que `{ topic }`. L'extension pour envoyer
  `companyProfile`/`recentMessages` est prête à être codée côté backend
  (elle a été specifiée puis mise en pause pour vous laisser la main sur le
  calendrier) — **dites-moi quand votre API `/ask` est hébergée et
  fonctionnelle, et je termine ce branchement côté NestJS dans la foulée**
  (changement d'une seule classe, sans migration de base de données).

Le RAG (documents de cadrage) et le text-to-SQL (table `campaigns`
synthétique) restent internes à votre service — le backend n'a pas besoin
de les connaître, ils enrichissent simplement la réponse que vous renvoyez
dans `answer`.

---

## 4. Authentification — obligatoire avant tout hébergement public

Aujourd'hui, rien ne protège vos endpoints. Une fois hébergé, n'importe qui
connaissant l'URL pourrait consommer votre quota LLM (coût) ou spammer
votre service.

**À faire** : un secret partagé simple, envoyé dans un en-tête HTTP,
vérifié en comparaison à temps constant (pas une simple égalité `==`, qui
fuit des informations de timing). C'est exactement le mécanisme déjà en
place côté NestJS pour un besoin similaire
(`InternalTokenGuard`/`MonitoringController`, si vous voulez un exemple
concret dans l'autre repo) :

```python
import hashlib
import hmac
import os
from fastapi import Header, HTTPException, status

INTERNAL_TOKEN = os.environ["INTERNAL_TOKEN"]  # échoue au démarrage si absent

def verify_internal_token(x_internal_token: str = Header(...)) -> None:
    expected_hash = hashlib.sha256(INTERNAL_TOKEN.encode()).digest()
    received_hash = hashlib.sha256(x_internal_token.encode()).digest()
    if not hmac.compare_digest(expected_hash, received_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
```

Appliquez cette dépendance sur `POST /ask` (`Depends(verify_internal_token)`).
Générez `INTERNAL_TOKEN` avec au moins 32 caractères aléatoires
(`openssl rand -hex 32` ou équivalent) — jamais une valeur simple à deviner.

**Retirez aussi tout `CORSMiddleware(allow_origins=["*"])`** s'il en existe
un pour ce service (il y en a un dans `simulation_api.py`, ne le recopiez
pas ici) : seul le backend NestJS doit pouvoir appeler cette API, jamais un
navigateur directement.

---

## 5. Hébergement du LLM

Point encore ouvert selon vos contraintes d'équipe — deux options
raisonnables :

- **API hébergée (Groq, ou équivalent)** : recommandé si vous n'avez pas
  déjà une contrainte contraire — palier gratuit généreux, latence très
  faible, aucune infra à maintenir. `llm_client.py` n'a qu'un seul endroit
  à changer (`ask_llm()`, remplacer l'appel `requests.post` vers Ollama par
  un appel vers l'API choisie — la plupart sont compatibles avec le format
  OpenAI `chat/completions`, migration mécanique).
- **Ollama auto-hébergé** (ce qui existe déjà) : gratuit à l'usage, mais
  nécessite un service tournant en continu (RAM dédiée), et sera lent sans
  GPU. Si vous gardez cette option, il vous faut un hébergeur qui vous
  laisse tourner un process long-lived (pas une simple fonction serverless
  à la demande).

Dans les deux cas, le contrat `/ask` du §3 ne change pas — c'est un détail
d'implémentation interne à votre service.

---

## 6. Avant de déployer — nettoyage recommandé

- `requirements.txt` (racine) est un `pip freeze` brut de l'environnement
  de dev (contient des paquets sans rapport, type `docker`,
  `databricks-sdk`, `Flask`...) — pas fiable pour la reproductibilité d'un
  build. Créez un `requirements-chatbot.txt` curaté (uniquement ce dont
  `scripts/chatbot/` + votre future API ont besoin :
  `fastapi`, `uvicorn`, `requests`, plus les dépendances RAG si conservées :
  `chromadb`, `sentence-transformers`), sur le modèle de
  `requirements-api.txt` qui, lui, est déjà propre.
- `mlruns/`, `mlflow.db` : artefacts de tracking MLflow liés au moteur
  XGBoost (§0) — à retirer si ce moteur est abandonné en faveur de
  `Kidata.2`. Contiennent déjà des chemins absolus d'une machine
  personnelle (`C:/Users/LOIC/...`), inutiles au runtime.
- Un `Dockerfile` dédié à ce service (pas besoin d'embarquer les
  dépendances de simulation si elles partent dans `Kidata.2`).
- Une route `GET /health` simple (200 si le service répond, y compris un
  éventuel test de connectivité vers le LLM/RAG au démarrage) — nécessaire
  pour tout health check d'hébergeur (Render ou autre), et pour que je
  puisse vérifier moi-même que le service répond avant de brancher NestJS
  dessus.

---

## 7. Definition of Done pour ce ticket

- [ ] `scripts/chatbot/06_chatbot.py` enveloppé dans une API FastAPI,
      endpoint `POST /ask` conforme au contrat §3.
- [ ] `GET /health` disponible.
- [ ] Authentification par `X-Internal-Token` (§4), comparaison à temps
      constant, CORS restreint (pas de wildcard).
- [ ] `requirements-chatbot.txt` curaté.
- [ ] `Dockerfile` fonctionnel, testé localement (`docker build` +
      `docker run` + un vrai appel `POST /ask`).
- [ ] Service hébergé, accessible depuis internet (ou depuis le réseau
      interne de l'hébergeur où tourne aussi `Liyanza-backend`, selon la
      méthode choisie).
- [ ] Décision prise sur le sort de `scripts/simulation/` (§0) —
      communiquée, pas nécessairement exécutée avant de livrer le chatbot.

## 8. Ce qu'il faut me communiquer une fois hébergé

1. **L'URL publique du service** (ex: `https://kiyanza-chatbot.onrender.com`
   ou équivalent selon l'hébergeur choisi).
2. **La méthode d'hébergement utilisée** (Render, Railway, VPS, autre) —
   certains détails de configuration réseau côté NestJS en dépendent
   (ex: liste blanche CORS si un jour un appel direct navigateur devient
   nécessaire, ce qui n'est pas le cas aujourd'hui).
3. **La valeur du secret `INTERNAL_TOKEN`** que vous avez configurée
   (transmise de façon sécurisée, jamais par un canal en clair type
   message public) — je la reporte à l'identique dans la config
   `Liyanza-backend`.
4. **Le modèle LLM utilisé et son fournisseur** (Groq/Ollama/autre) — pour
   information, sans impact sur le contrat.
5. Confirmation que `GET /health` répond `200`.

Une fois ces informations reçues, je crée le client HTTP côté NestJS
(`IAEngineHttpClient`), j'ajoute les variables d'environnement
(`IA_SERVICE_URL`, `IA_SERVICE_INTERNAL_TOKEN`) et je bascule le module
`assistant-ia` du mock vers votre service réel — normalement sans rien
casser côté frontend/mobile (le contrat de réponse `{ answer }` ne change
pas de leur point de vue).
