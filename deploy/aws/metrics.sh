#!/bin/sh
# Envoie à CloudWatch (espace « Kiyanza ») l'occupation du disque et la
# mémoire disponible, que l'hyperviseur ne voit pas. Lancé toutes les 5
# minutes par cron (voir README.md) ; les alarmes sont dans monitoring.sh.
#
# Le serveur écrit dans CloudWatch grâce à son rôle IAM : aucune clé sur la machine.
set -eu

disk=$(df --output=pcent / | tail -1 | tr -dc '0-9')
memory=$(awk '/^MemAvailable:/ { printf "%d", $2 / 1024 }' /proc/meminfo)

aws cloudwatch put-metric-data --region eu-west-3 --namespace Kiyanza --metric-data \
  "MetricName=DiskUsedPercent,Value=$disk,Unit=Percent" \
  "MetricName=MemoryAvailableMB,Value=$memory,Unit=Megabytes"
