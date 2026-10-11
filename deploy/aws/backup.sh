#!/bin/sh
# Sauvegarde de la base vers S3 (format custom de pg_dump, restaurable avec
# pg_restore). Lancé chaque nuit par cron (voir README.md) ; le bucket
# supprime les sauvegardes de plus de 30 jours.
#
#   BACKUP_BUCKET  bucket S3 cible (défini dans .env)
#
# Le dump passe par un fichier local et n'est envoyé que s'il est lisible par
# pg_restore : un pg_dump en échec ne produit plus une sauvegarde vide. Une
# réussite est signalée à CloudWatch (métrique Kiyanza/BackupSucceeded) ;
# sans elle pendant 25 heures, l'alarme « kiyanza-backup-missing » prévient.
#
# Le serveur écrit dans S3 et CloudWatch grâce à son rôle IAM : aucune clé sur la machine.
set -eu

cd "$(dirname "$0")"
BACKUP_BUCKET=$(grep '^BACKUP_BUCKET=' .env | cut -d= -f2-)
: "${BACKUP_BUCKET:?BACKUP_BUCKET manquant dans .env}"

dump=$(mktemp /tmp/kiyanza-backup.XXXXXX)
trap 'rm -f "$dump"' EXIT

docker compose exec -T postgres sh -c 'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$dump"
docker compose exec -T postgres pg_restore --list > /dev/null < "$dump"

key="postgres/$(date -u +%Y-%m-%dT%H%M%SZ).dump"
aws s3 cp "$dump" "s3://$BACKUP_BUCKET/$key" --only-show-errors
aws cloudwatch put-metric-data --region eu-west-3 --namespace Kiyanza \
  --metric-name BackupSucceeded --value 1 --unit Count
echo "Sauvegarde envoyée : s3://$BACKUP_BUCKET/$key ($(wc -c < "$dump") octets)"
