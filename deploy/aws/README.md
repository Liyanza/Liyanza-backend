# Déploiement AWS

Le backend et le site (`www.kiyanza.com`, dépôt Liyanza) tournent sur une instance EC2 dédiée, en région Paris (`eu-west-3`).

| Ressource | Valeur |
|---|---|
| Compte AWS | `922640335967` (CM - 1) |
| Instance | `kiyanza-backend` (`i-092ed836d43e8cec5`), t3.small, Ubuntu 24.04, 2 Go de swap |
| IP fixe | `13.39.6.244`, enregistrements DNS `api.kiyanza.com`, `www.kiyanza.com` et `kiyanza.com` chez LWS |
| Groupe de sécurité | `kiyanza-backend-web` : ports 80 et 443 uniquement, **pas de SSH** |
| Rôle IAM | `kiyanza-backend-ec2` : Session Manager, écriture des sauvegardes et des métriques, lecture de l'image du site |
| Sauvegardes | `s3://kiyanza-backend-backups-922640335967/postgres/`, conservées 30 jours |
| Image du site | ECR `kiyanza-web`, étiquette `prod` = version en ligne, 10 dernières images conservées |

Les conteneurs sont décrits dans [`docker-compose.yml`](docker-compose.yml) :

- **Caddy** gère le HTTPS automatiquement, configuré par [`caddy/Caddyfile`](caddy/Caddyfile) : `api.kiyanza.com` → API, `www.kiyanza.com` → site, `kiyanza.com` → redirection vers www.
- **Le site** (Next.js) est construit par la CI du dépôt Liyanza, voir [Site](#site-wwwkiyanzacom).
- **L'API** démarre par `prisma migrate deploy`.
- **PostgreSQL** stocke les données dans un volume persistant.
- **Redis** est réglé en `noeviction`, avec AOF.

## Accès au serveur

Il n'y a pas de SSH : l'accès passe par Session Manager. Il faut l'AWS CLI et le plugin Session Manager.

```sh
aws ssm start-session --target i-092ed836d43e8cec5 --profile kiyanza
sudo -iu ubuntu
cd /opt/kiyanza/backend/deploy/aws
```

## Déploiement automatique

Chaque push sur `main` déclenche le job **Deploy (AWS)** de [`ci.yml`](../../.github/workflows/ci.yml). Il ne part que si le lint, le build et les tests sont passés.

1. GitHub obtient des identifiants AWS temporaires par OIDC, avec le rôle `github-deploy-backend`. Aucune clé n'est stockée dans GitHub. Ce rôle n'accepte que ce dépôt et la branche `main`. Il ne peut que déposer le bundle et lancer Session Manager sur cette instance.
2. Le serveur n'a aucun accès à GitHub : le job lui envoie le code sous forme de bundle git, déposé dans `s3://kiyanza-backend-backups-922640335967/deploy/backend.bundle`.
3. Par Session Manager, le serveur récupère le bundle et place `main` sur ce commit. Il lance ensuite [`deploy.sh`](deploy.sh), qui reconstruit la stack et attend que l'API soit « healthy ». Les migrations Prisma s'appliquent au démarrage de l'API.
4. Le job vérifie enfin `https://api.kiyanza.com/health`.

Si l'API ne démarre pas, le job échoue et affiche ses derniers journaux. Deux déploiements ne tournent jamais en même temps.

### Déployer à la main

Pour une autre branche, ou si GitHub Actions est indisponible, depuis un clone complet :

```sh
git branch -f deploy HEAD && git bundle create backend.bundle refs/heads/deploy
aws s3 cp backend.bundle s3://kiyanza-backend-backups-922640335967/deploy/backend.bundle --profile kiyanza
```

Ensuite, sur le serveur, en root :

```sh
cd /opt/kiyanza/backend
aws s3 cp s3://kiyanza-backend-backups-922640335967/deploy/backend.bundle /tmp/backend.bundle
sudo -u ubuntu git fetch -q /tmp/backend.bundle deploy
sudo -u ubuntu git checkout -q -f -B main FETCH_HEAD
sh deploy/aws/deploy.sh
```

## Site (www.kiyanza.com)

Le site (dépôt `Liyanza`, Next.js) tourne dans le conteneur `web`, derrière le même Caddy. Le serveur ne le compile pas : chaque push sur `main` du dépôt Liyanza lance son workflow **Deploy (AWS)**.

1. GitHub Actions construit l'image Docker et la pousse dans ECR (`kiyanza-web`), étiquetée par le commit et par `prod`. Le rôle OIDC `github-deploy-web` n'accepte que la branche `main` du dépôt Liyanza.
2. Par Session Manager, le serveur lance [`deploy-web.sh`](deploy-web.sh). Le script récupère `prod`, relance le conteneur et attend qu'il soit « healthy ».

Un verrou (`/opt/kiyanza/deploy.lock`) empêche un déploiement du site et un déploiement du backend de se chevaucher. `deploy.sh` ne relance pas le site.

Le site reçoit `WEB_PROXY_SECRET` depuis `.env`, la même valeur que l'API. Les variables `NEXT_PUBLIC_*` sont figées au build : elles se règlent dans les variables du dépôt Liyanza sur GitHub (Settings → Secrets and variables → Actions → Variables), pas sur le serveur.

### Mise en place (une fois)

```sh
MSYS_NO_PATHCONV=1 AWS_PROFILE=kiyanza sh deploy/aws/setup-web.sh
```

Le script crée le dépôt ECR, le rôle `github-deploy-web` et la lecture ECR pour l'instance. Il peut être relancé sans risque.

### Bascule DNS du site

Caddy n'obtient le certificat de `www.kiyanza.com` et de `kiyanza.com` qu'une fois leur DNS pointé vers l'instance. Avant, il réessaie seul, en espaçant ses tentatives.

1. Déployer le site au moins une fois (workflow du dépôt Liyanza) et vérifier sur le serveur que `docker compose ps web` affiche `healthy`.
2. Chez LWS : enregistrement `A` de `kiyanza.com` → `13.39.6.244`, et `www` → `A 13.39.6.244`. Il faut supprimer le `CNAME`/`A` de Vercel.
3. Une fois le DNS propagé (`nslookup www.kiyanza.com` renvoie `13.39.6.244`), relancer Caddy. Il retente alors tout de suite au lieu d'attendre la fin de sa pause :

   ```sh
   docker compose restart caddy
   docker compose logs caddy --tail 30   # « certificate obtained successfully »
   ```

### Retour arrière du site

Remettre l'étiquette `prod` sur une image précédente (commit `<sha>`), puis relancer le déploiement :

```sh
manifest=$(aws ecr batch-get-image --region eu-west-3 --repository-name kiyanza-web --image-ids imageTag=<sha> --query 'images[0].imageManifest' --output text --profile kiyanza)
aws ecr put-image --region eu-west-3 --repository-name kiyanza-web --image-tag prod --image-manifest "$manifest" --profile kiyanza
# puis, sur le serveur, en root :
sh /opt/kiyanza/backend/deploy/aws/deploy-web.sh
```

## Secrets

Les secrets vivent dans `deploy/aws/.env`, sur le serveur uniquement : ce fichier n'est jamais commité ni copié dans l'image. Pour le modèle, voir [`.env.example`](.env.example) et le `.env.example` à la racine.

Après une modification : `docker compose up -d api` (et `docker compose up -d web` si `WEB_PROXY_SECRET` a changé).

## Sauvegardes

Un cron de l'utilisateur `ubuntu` lance `backup.sh` chaque nuit à 2 h UTC. Le dump n'est envoyé que si `pg_restore` arrive à le lire.

```
0 2 * * * /opt/kiyanza/backend/deploy/aws/backup.sh >> /opt/kiyanza/backup.log 2>&1
```

Pour restaurer une sauvegarde :

```sh
aws s3 cp s3://kiyanza-backend-backups-922640335967/postgres/<fichier>.dump /tmp/restore.dump
docker compose exec -T postgres sh -c 'pg_restore --clean --if-exists --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < /tmp/restore.dump
```

## Journaux

```sh
docker compose logs -f api
docker compose logs -f web
docker compose ps
```

## Surveillance

[`monitoring.sh`](monitoring.sh) crée les alertes. Il se lance depuis un poste d'administration et peut être relancé sans risque :

```sh
ALERT_EMAILS="moi@exemple.com associe@exemple.com" AWS_PROFILE=kiyanza sh deploy/aws/monitoring.sh
```

Depuis Git Bash sous Windows, préfixer la commande par `MSYS_NO_PATHCONV=1` : sinon `/health` est converti en chemin Windows.

Chaque alerte, puis le retour à la normale, est envoyée par e-mail via les sujets SNS `kiyanza-alerts` (us-east-1 et eu-west-3). Une nouvelle adresse doit d'abord confirmer l'e-mail d'abonnement envoyé par AWS.

| Alarme | Déclenchement | Action automatique |
|---|---|---|
| `kiyanza-api-down`, `kiyanza-ia-down`, `kiyanza-web-down` | Une sonde Route 53 échoue depuis 2 minutes (`/health` de l'API et de l'IA, page d'accueil du site) | — |
| `kiyanza-backend-host-failure` | Panne de l'hôte AWS | Instance relancée sur un autre hôte |
| `kiyanza-backend-unresponsive` | Le système ne répond plus depuis 3 minutes | Redémarrage |
| `kiyanza-backend-cpu-high` | Processeur au-dessus de 85 % pendant 15 minutes | — |
| `kiyanza-backend-disk-full` | Disque rempli à plus de 85 % | — |
| `kiyanza-backend-memory-low` | Moins de 150 Mo de mémoire disponible pendant 15 minutes | — |
| `kiyanza-backup-missing` | Aucune sauvegarde réussie depuis 25 heures | — |

L'hyperviseur ne voit ni le disque ni la mémoire. [`metrics.sh`](metrics.sh) les envoie à CloudWatch toutes les 5 minutes, via un cron de l'utilisateur `ubuntu` :

```
*/5 * * * * /opt/kiyanza/backend/deploy/aws/metrics.sh > /dev/null 2>> /opt/kiyanza/metrics.log
```
