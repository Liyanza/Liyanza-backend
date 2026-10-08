#!/bin/sh
# Reconstruit et relance la stack avec le code déjà extrait dans
# /opt/kiyanza/backend, puis attend que l'API soit « healthy ». Lancé par le
# job « Deploy (AWS) » de la CI (via Session Manager, en root) juste après la
# mise à jour du code ; utilisable aussi à la main.
#
# Les migrations Prisma s'appliquent au démarrage de l'API. En cas d'échec,
# les derniers journaux de l'API sont affichés et le script sort en erreur,
# ce qui fait échouer le job.
set -eu

cd "$(dirname "$0")"

docker compose up -d --build --remove-orphans

status=starting
for _ in $(seq 1 36); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q api)" 2>/dev/null || echo missing)
  [ "$status" = healthy ] && break
  sleep 5
done

if [ "$status" != healthy ]; then
  echo "L'API n'est pas healthy après 3 minutes (état : $status). Derniers journaux :"
  docker compose logs api --tail 60 --no-color
  exit 1
fi

# Images remplacées par le build : libère le disque.
docker image prune -f > /dev/null
echo "Déployé : $(git -c safe.directory='*' -C ../.. log --oneline -1)"
