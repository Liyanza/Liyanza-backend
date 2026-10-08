# Déploiement AWS

Le backend tourne sur une instance EC2 dédiée, en région Paris (`eu-west-3`).

| Ressource | Valeur |
|---|---|
| Compte AWS | `922640335967` (CM - 1) |
| Instance | `kiyanza-backend` (`i-092ed836d43e8cec5`), t3.small, Ubuntu 24.04, 2 Go de swap |
| IP fixe | `13.39.6.244`, enregistrement DNS `api.kiyanza.com` chez LWS |
| Groupe de sécurité | `kiyanza-backend-web` : ports 80 et 443 uniquement, **pas de SSH** |
| Rôle IAM | `kiyanza-backend-ec2` : Session Manager et écriture des sauvegardes |
| Sauvegardes | `s3://kiyanza-backend-backups-922640335967/postgres/`, conservées 30 jours |

Les conteneurs sont décrits dans [`docker-compose.yml`](docker-compose.yml) :

- **Caddy** gère le HTTPS automatiquement.
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

## Secrets

Les secrets vivent dans `deploy/aws/.env`, sur le serveur uniquement : ce fichier n'est jamais commité ni copié dans l'image. Pour le modèle, voir [`.env.example`](.env.example) et le `.env.example` à la racine.

Après une modification : `docker compose up -d api`.

## Sauvegardes

Un cron de l'utilisateur `ubuntu` lance `backup.sh` chaque nuit à 2 h UTC :

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
docker compose ps
```
