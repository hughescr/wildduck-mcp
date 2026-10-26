#!/usr/bin/env bash
set -euo pipefail
: "${AWS_DEPLOYMENT_BUCKET_NAME:?Set this from the bootstrap ArtifactBucketName output}"
: "${AWS_EXECUTION_ROLE_ARN:?Set this from the bootstrap ExecutionRoleArn output}"
: "${SERVERLESS_ACCESS_KEY:?Set a Serverless Framework access key}"
: "${PUBLIC_BASE_URL:?Set the canonical HTTPS Function URL origin}"
: "${AUTH_KEYRING_PARAMETER:?Set the exact SSM keyring parameter name}"
[[ "$AUTH_KEYRING_PARAMETER" == '/wildduck-mcp/prod/auth-keyring' ]] || { echo 'Unexpected auth keyring parameter name' >&2; exit 1; }
node_modules/.bin/serverless deploy --stage prod
