#!/bin/sh
# Sauvegarde de la base vers S3 (format custom de pg_dump, restaurable avec
# pg_restore). Lancé chaque nuit par cron (voir README.md) ; le bucket
# supprime les sauvegardes de plus de 30 jours.
#
#   BACKUP_BUCKET  bucket S3 cible (défini dans .env)
#
# Le serveur écrit dans S3 grâce à son rôle IAM : aucune clé sur la machine.
set -eu

cd "$(dirname "$0")"
BACKUP_BUCKET=$(grep '^BACKUP_BUCKET=' .env | cut -d= -f2-)
: "${BACKUP_BUCKET:?BACKUP_BUCKET manquant dans .env}"

key="postgres/$(date -u +%Y-%m-%dT%H%M%SZ).dump"
docker compose exec -T postgres sh -c 'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  | aws s3 cp - "s3://$BACKUP_BUCKET/$key" --only-show-errors
echo "Sauvegarde envoyée : s3://$BACKUP_BUCKET/$key"
