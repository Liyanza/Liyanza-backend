#!/bin/sh
# Déploie le site (service web) : récupère l'image kiyanza-web:prod dans ECR,
# relance le conteneur et attend qu'il soit « healthy ». Lancé par le job
# « Deploy (AWS) » du dépôt Liyanza (via Session Manager, en root), après le
# push de l'image ; utilisable aussi à la main.
#
# Retour arrière : réétiqueter « prod » sur une image précédente dans ECR
# (voir README), puis relancer ce script.
set -eu

cd "$(dirname "$0")"

exec 9>/opt/kiyanza/deploy.lock
flock 9

registry=922640335967.dkr.ecr.eu-west-3.amazonaws.com
aws ecr get-login-password --region eu-west-3 | docker login --username AWS --password-stdin "$registry" > /dev/null

docker compose pull -q web
docker compose up -d web

status=starting
for _ in $(seq 1 24); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q web)" 2>/dev/null || echo missing)
  [ "$status" = healthy ] && break
  sleep 5
done

if [ "$status" != healthy ]; then
  echo "Le site n'est pas healthy après 2 minutes (état : $status). Derniers journaux :"
  docker compose logs web --tail 60 --no-color
  exit 1
fi

docker logout "$registry" > /dev/null
# Anciennes images du site : libère le disque.
docker image prune -f > /dev/null
echo "Site déployé : $(docker inspect -f '{{.Image}}' "$(docker compose ps -q web)" | cut -c8-19)"
