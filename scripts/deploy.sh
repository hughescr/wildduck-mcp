#!/usr/bin/env bash
set -euo pipefail
: "${AWS_DEPLOYMENT_BUCKET_NAME:?Set this from the bootstrap ArtifactBucketName output}"
: "${AWS_EXECUTION_ROLE_ARN:?Set this from the bootstrap ExecutionRoleArn output}"
: "${SERVERLESS_ACCESS_KEY:?Set a Serverless Framework access key}"
node_modules/.bin/serverless deploy --stage prod
