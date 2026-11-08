#!/bin/sh
# Mise en place AWS, une seule fois, de l'hébergement du site (dépôt Liyanza)
# sur cette instance. À lancer depuis un poste d'administration ; peut être
# relancé sans risque.
#
#   AWS_PROFILE=kiyanza sh deploy/aws/setup-web.sh
#
# Depuis Git Bash sous Windows : préfixer par MSYS_NO_PATHCONV=1.
#
# Crée :
#   - le dépôt ECR kiyanza-web (10 dernières images conservées) ;
#   - le rôle github-deploy-web, pris par GitHub Actions (OIDC) depuis la
#     branche main du dépôt Liyanza uniquement : push de l'image dans ECR et
#     lancement de deploy-web.sh par Session Manager sur cette instance ;
#   - la politique pull-web-image du rôle de l'instance (kiyanza-backend-ec2) :
#     lecture de l'image dans ECR.
set -eu

ACCOUNT=922640335967
REGION=eu-west-3
INSTANCE=i-092ed836d43e8cec5
REPO=kiyanza-web
REPO_ARN="arn:aws:ecr:$REGION:$ACCOUNT:repository/$REPO"
# Sujet immuable GitHub (organisation@id/dépôt@id), comme github-deploy-backend.
GITHUB_SUB="repo:Liyanza@316123710/Liyanza@1331834077:ref:refs/heads/main"

if aws ecr describe-repositories --region "$REGION" --repository-names "$REPO" > /dev/null 2>&1; then
  echo "Dépôt ECR $REPO : existe déjà"
else
  aws ecr create-repository --region "$REGION" --repository-name "$REPO" \
    --image-scanning-configuration scanOnPush=true > /dev/null
  echo "Dépôt ECR $REPO : créé"
fi

aws ecr put-lifecycle-policy --region "$REGION" --repository-name "$REPO" --lifecycle-policy-text '{
  "rules": [{
    "rulePriority": 1,
    "description": "Garder les 10 dernieres images",
    "selection": {"tagStatus": "any", "countType": "imageCountMoreThan", "countNumber": 10},
    "action": {"type": "expire"}
  }]
}' > /dev/null

trust=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Federated": "arn:aws:iam::$ACCOUNT:oidc-provider/token.actions.githubusercontent.com"},
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {"StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": "$GITHUB_SUB"
    }}
  }]
}
EOF
)

if aws iam get-role --role-name github-deploy-web > /dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name github-deploy-web --policy-document "$trust"
  echo "Rôle github-deploy-web : confiance mise à jour"
else
  aws iam create-role --role-name github-deploy-web \
    --description "GitHub Actions Liyanza (site) : push ECR + deploiement SSM" \
    --assume-role-policy-document "$trust" > /dev/null
  echo "Rôle github-deploy-web : créé"
fi

aws iam put-role-policy --role-name github-deploy-web --policy-name deploy-web --policy-document "$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {"Sid": "EcrLogin", "Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*"},
    {"Sid": "PushWebImage", "Effect": "Allow", "Resource": "$REPO_ARN", "Action": [
      "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage"
    ]},
    {"Sid": "RunDeployOnInstance", "Effect": "Allow", "Action": "ssm:SendCommand", "Resource": [
      "arn:aws:ec2:$REGION:$ACCOUNT:instance/$INSTANCE",
      "arn:aws:ssm:$REGION::document/AWS-RunShellScript"
    ]},
    {"Sid": "ReadDeployResult", "Effect": "Allow", "Resource": "*",
     "Action": ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"]}
  ]
}
EOF
)"
echo "Rôle github-deploy-web : politique deploy-web appliquée"

aws iam put-role-policy --role-name kiyanza-backend-ec2 --policy-name pull-web-image --policy-document "$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*"},
    {"Effect": "Allow", "Resource": "$REPO_ARN",
     "Action": ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]}
  ]
}
EOF
)"
echo "Rôle kiyanza-backend-ec2 : politique pull-web-image appliquée"
