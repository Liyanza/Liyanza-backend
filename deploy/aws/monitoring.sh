#!/bin/sh
# Crée ou met à jour la surveillance de la production. À lancer depuis un
# poste d'administration (pas depuis le serveur) ; relançable sans risque.
#
#   ALERT_EMAIL=moi@exemple.com AWS_PROFILE=kiyanza sh deploy/aws/monitoring.sh
#
# Chaque alerte, et le retour à la normale, part par e-mail via un sujet SNS
# « kiyanza-alerts ». Il en existe un par région, car une alarme ne notifie
# que dans la sienne : us-east-1 pour les sondes Route 53, eu-west-3 pour le
# serveur. Chaque nouvelle adresse reçoit un e-mail de confirmation d'AWS.
#
# Coût indicatif : ~5 $/mois (sondes HTTPS Route 53, métriques personnalisées).
set -eu

: "${ALERT_EMAIL:?définir ALERT_EMAIL}"
INSTANCE_ID=i-092ed836d43e8cec5
SERVER_REGION=eu-west-3
EC2_ROLE=kiyanza-backend-ec2

# Droit du serveur d'écrire ses métriques, et seulement dans l'espace Kiyanza.
aws iam put-role-policy --role-name "$EC2_ROLE" --policy-name cloudwatch-metrics --policy-document '{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "cloudwatch:PutMetricData",
    "Resource": "*",
    "Condition": { "StringEquals": { "cloudwatch:namespace": "Kiyanza" } }
  }]
}'

topic() {
  arn=$(aws sns create-topic --region "$1" --name kiyanza-alerts --query TopicArn --output text)
  if ! aws sns list-subscriptions-by-topic --region "$1" --topic-arn "$arn" \
    --query 'Subscriptions[].Endpoint' --output text | tr '\t' '\n' | grep -qx "$ALERT_EMAIL"; then
    aws sns subscribe --region "$1" --topic-arn "$arn" --protocol email --notification-endpoint "$ALERT_EMAIL" > /dev/null
    echo "Confirmation envoyée à $ALERT_EMAIL ($1)." >&2
  fi
  echo "$arn"
}

# alarm <région> <nom> <description> <actions> <arguments de put-metric-alarm…>
alarm() {
  region=$1 name=$2 description=$3 actions=$4
  shift 4
  # shellcheck disable=SC2086 # plusieurs actions séparées par des espaces
  aws cloudwatch put-metric-alarm --region "$region" --alarm-name "$name" \
    --alarm-description "$description" --alarm-actions $actions --ok-actions $actions "$@"
  echo "Alarme $name" >&2
}

# --- Sondes publiques (Route 53 interroge depuis plusieurs régions) ------

GLOBAL_TOPIC=$(topic us-east-1)

# probe <nom> <domaine> <chemin> : identifiant de la sonde HTTPS.
probe() {
  id=$(aws route53 list-health-checks \
    --query "HealthChecks[?HealthCheckConfig.FullyQualifiedDomainName=='$2' && HealthCheckConfig.ResourcePath=='$3'].Id | [0]" --output text)
  if [ "$id" = None ]; then
    id=$(aws route53 create-health-check --caller-reference "kiyanza-$1-$(date +%s)" \
      --health-check-config "Type=HTTPS,FullyQualifiedDomainName=$2,Port=443,ResourcePath=$3,RequestInterval=30,FailureThreshold=3,EnableSNI=true" \
      --query HealthCheck.Id --output text)
    aws route53 change-tags-for-resource --resource-type healthcheck --resource-id "$id" --add-tags "Key=Name,Value=kiyanza-$1"
  fi
  echo "$id"
}

for check in "api api.kiyanza.com /health" "ia ia.kiyanza.com /health" "web www.kiyanza.com /"; do
  set -- $check
  id=$(probe "$1" "$2" "$3")
  alarm us-east-1 "kiyanza-$1-down" "https://$2$3 ne répond plus correctement depuis 2 minutes." "$GLOBAL_TOPIC" \
    --namespace AWS/Route53 --metric-name HealthCheckStatus --dimensions "Name=HealthCheckId,Value=$id" \
    --statistic Minimum --period 60 --evaluation-periods 2 --threshold 1 \
    --comparison-operator LessThanThreshold --treat-missing-data breaching
done

# --- Serveur backend ---------------------------------------------------------

TOPIC=$(topic "$SERVER_REGION")
INSTANCE="Name=InstanceId,Value=$INSTANCE_ID"

# Panne matérielle d'AWS : l'instance est relancée sur un autre hôte (même IP, même disque).
alarm "$SERVER_REGION" kiyanza-backend-host-failure "Panne de l'hôte AWS : récupération automatique de l'instance lancée." \
  "$TOPIC arn:aws:automate:$SERVER_REGION:ec2:recover" \
  --namespace AWS/EC2 --metric-name StatusCheckFailed_System --dimensions "$INSTANCE" \
  --statistic Maximum --period 60 --evaluation-periods 2 --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold

# Système bloqué (noyau, mémoire épuisée…) : redémarrage automatique.
alarm "$SERVER_REGION" kiyanza-backend-unresponsive "Le serveur ne répond plus à AWS : redémarrage automatique lancé." \
  "$TOPIC arn:aws:automate:$SERVER_REGION:ec2:reboot" \
  --namespace AWS/EC2 --metric-name StatusCheckFailed_Instance --dimensions "$INSTANCE" \
  --statistic Maximum --period 60 --evaluation-periods 3 --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold

alarm "$SERVER_REGION" kiyanza-backend-cpu-high "Processeur au-dessus de 85 % depuis 15 minutes." "$TOPIC" \
  --namespace AWS/EC2 --metric-name CPUUtilization --dimensions "$INSTANCE" \
  --statistic Average --period 300 --evaluation-periods 3 --threshold 85 --comparison-operator GreaterThanThreshold

# Métriques envoyées par metrics.sh et backup.sh.
alarm "$SERVER_REGION" kiyanza-backend-disk-full "Disque du serveur rempli à plus de 85 %." "$TOPIC" \
  --namespace Kiyanza --metric-name DiskUsedPercent \
  --statistic Maximum --period 300 --evaluation-periods 2 --threshold 85 \
  --comparison-operator GreaterThanThreshold --treat-missing-data breaching

alarm "$SERVER_REGION" kiyanza-backend-memory-low "Moins de 150 Mo de mémoire disponible depuis 15 minutes." "$TOPIC" \
  --namespace Kiyanza --metric-name MemoryAvailableMB \
  --statistic Minimum --period 300 --evaluation-periods 3 --threshold 150 \
  --comparison-operator LessThanThreshold --treat-missing-data breaching

alarm "$SERVER_REGION" kiyanza-backup-missing "Aucune sauvegarde de la base réussie depuis 25 heures (voir /opt/kiyanza/backup.log)." "$TOPIC" \
  --namespace Kiyanza --metric-name BackupSucceeded \
  --statistic Sum --period 3600 --evaluation-periods 25 --datapoints-to-alarm 25 --threshold 1 \
  --comparison-operator LessThanThreshold --treat-missing-data breaching

echo "Surveillance à jour." >&2
