# Configuration de l'App Meta for Developers (BACK-502/503)

Ce document explique comment configurer, côté dashboard Meta, l'App
existante (`App ID 1797078368136445`) pour qu'elle fonctionne avec le flow
OAuth implémenté dans ce repo (`SocialAccountsModule`). Ces étapes se font
sur https://developers.facebook.com/apps/ — je (Claude Code) ne peux pas les
effectuer à votre place, elles nécessitent votre propre connexion au
dashboard.

## 1. Ajouter le produit "Facebook Login"

1. Ouvrez votre App sur https://developers.facebook.com/apps/1797078368136445/
   (ou "Mes Apps" → sélectionnez l'App si l'ID a changé).
2. Dans le menu de gauche, "Ajouter un produit" → cherchez **"Facebook
   Login"** (ou "Connexion Facebook") → "Configurer".
3. Choisissez le type **"Web"** lors de la configuration initiale (même si
   la cible finale est mobile — c'est ce backend qui héberge le callback
   OAuth, un navigateur/webview y est toujours redirigé).

## 2. Déclarer l'URI de redirection OAuth

Dans "Facebook Login" → "Paramètres" (dans le menu de gauche) :

- **"Valid OAuth Redirect URIs"** : ajoutez EXACTEMENT la valeur de
  `META_OAUTH_REDIRECT_URI` dans votre `.env` local :
  ```
  http://localhost:3000/social-accounts/oauth/callback
  ```
  Meta accepte `http://localhost` en développement (pas besoin de HTTPS tant
  que vous testez en local). Le jour où ce backend est déployé (Render), il
  faudra ajouter l'URL de production équivalente
  (`https://votre-domaine/social-accounts/oauth/callback`) à cette même
  liste, et mettre à jour `META_OAUTH_REDIRECT_URI` sur Render en
  conséquence.
- **"Client OAuth Login"** et **"Web OAuth Login"** : activés (Oui).

## 3. Vous ajouter comme testeur/développeur de l'App

Tant que l'App n'a pas passé l'**App Review** de Meta, **seuls les comptes
Facebook explicitement ajoutés à l'App** (rôle Admin, Développeur ou
Testeur) peuvent compléter le flow OAuth — toute autre personne recevra une
erreur "Cette app est en mode développement".

1. "Paramètres" → "Rôles de base" (ou "App Roles" → "Roles").
2. Ajoutez votre propre compte Facebook (celui que vous utiliserez pour
   tester) comme **Administrateur** ou **Développeur**.
3. Si votre entreprise a une Page Facebook de test, assurez-vous que ce
   compte en est administrateur — c'est cette Page que
   `MetaGraphClient.getAccountProfile()` ira chercher via `/me/accounts`.

## 4. Permissions demandées par ce repo

Le backend demande ces scopes à l'utilisateur lors de l'autorisation (voir
`REQUESTED_SCOPES` dans `social-accounts.service.ts`) :

| Plateforme | Scopes                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------ |
| Facebook   | `pages_show_list`, `pages_read_engagement`, `read_insights`                                |
| Instagram  | `pages_show_list`, `pages_read_engagement`, `instagram_basic`, `instagram_manage_insights` |

En mode développement (App non review), ces permissions fonctionnent
automatiquement pour les comptes Admin/Développeur/Testeur ajoutés à
l'étape 3, **sans App Review**. L'App Review ne devient nécessaire que le
jour où un utilisateur qui n'est PAS dans cette liste doit pouvoir se
connecter (utilisation publique réelle).

## 5. Instagram : compte professionnel lié à une Page

`MetaGraphClient` résout un compte Instagram via
`instagram_business_account` sur la Page Facebook — cela suppose que :

- La Page Facebook de test a bien un compte Instagram **professionnel**
  (Business ou Creator, pas un compte personnel) lié, via les paramètres de
  la Page ou l'app Instagram elle-même ("Paramètres" → "Comptes liés").

Sans ce lien, sélectionner Instagram dans le wizard échouera avec un message
explicite (`No Instagram professional account linked...`) plutôt qu'une
erreur opaque.

## 6. Tester le flow de bout en bout

Une fois les étapes 1-3 faites :

1. Démarrez le backend (`npm run start:dev`).
2. Authentifiez-vous via `POST /auth/login` avec un compte `ADMIN` ou
   `MARKETING_MANAGER` de votre entreprise de test, récupérez l'`accessToken`.
3. Appelez `POST /social-accounts/oauth/facebook/start` (Bearer token) —
   la réponse contient `{ authorizationUrl }`.
4. Ouvrez cette URL dans un navigateur (celui où vous êtes connecté au
   compte Facebook ajouté à l'étape 3), acceptez les permissions demandées.
5. Meta vous redirige vers `META_OAUTH_REDIRECT_URI` avec un `code` — le
   backend échange ce code, résout votre Page, chiffre et stocke le token,
   puis redirige votre navigateur vers `SOCIAL_OAUTH_MOBILE_REDIRECT_URL`
   avec `?status=success&platform=facebook` (ou `?status=error&reason=...`
   en cas de problème).
6. Vérifiez `GET /social-accounts` — le compte doit apparaître avec
   `status: ACTIVE`. Le job de synchronisation initial tourne en tâche de
   fond (file `social-metrics-sync`, visible dans Bull Board
   `/admin/queues` si vous êtes ADMIN) ; une fois traité,
   `GET /campagnes/:id/digital-details` (pour une campagne DIGITAL dont ce
   compte est sélectionné comme canal) reflète les métriques réelles lors
   d'une simulation.

Je (Claude Code) ne peux pas exécuter les étapes 3-4 moi-même : elles
demandent un vrai login + consentement dans un navigateur, une interaction
humaine. Tout le reste (code, tests, migration, démarrage de l'application)
est déjà vérifié — voir `docs/BACKLOG_REORIENTE.md`, section Phase 5.
