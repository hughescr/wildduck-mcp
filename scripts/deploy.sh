#!/usr/bin/env bash
set -euo pipefail
: "${AWS_DEPLOYMENT_BUCKET_NAME:?Set this from the bootstrap ArtifactBucketName output}"
: "${AWS_EXECUTION_ROLE_ARN:?Set this from the bootstrap ExecutionRoleArn output}"
: "${SERVERLESS_ACCESS_KEY:?Set a Serverless Framework access key}"
: "${AUTH_KEYRING_PARAMETER:?Set the exact SSM keyring parameter name}"
[[ "$AUTH_KEYRING_PARAMETER" == '/wildduck-mcp/prod/auth-keyring' ]] || { echo 'Unexpected auth keyring parameter name' >&2; exit 1; }
node_modules/.bin/serverless deploy --stage prod

# Post-deploy housekeeping. Every deploy publishes a new numbered version of the
# function (versionFunctions: true) and nothing else removes old ones. This runs only
# after the deploy above has succeeded, and it is best-effort: a failure here prints
# one WARNING line and never changes the exit status.
prune_old_versions() {
  # Mirrors serverless.yml: service wildduck-mcp, stage prod, function api, provider.region.
  local function_name='wildduck-mcp-prod-api'
  local region='us-west-2'
  # Newest numbered versions to keep (rollback window).
  local keep_versions=5
  local aliases_json refs protected versions_text numbered candidates version deleted=0

  if ! aliases_json="$(aws lambda list-aliases --function-name "$function_name" --region "$region" --output json)"; then
    echo "WARNING: could not list aliases for $function_name; skipped version pruning" >&2
    return 0
  fi
  # Protect every version an alias uses. Both FunctionVersion and each AdditionalVersionWeights
  # key (a routing target) appear as quoted integers. Alias names cannot be all digits, so this
  # can only over-match, which keeps an extra version; it cannot delete a referenced one.
  refs="$(grep -oE '"[0-9]+"' <<<"$aliases_json" || true)"
  protected="$(tr -d '"' <<<"$refs" | sort -u)"

  if ! versions_text="$(aws lambda list-versions-by-function --function-name "$function_name" --region "$region" --query 'Versions[].Version' --output text)"; then
    echo "WARNING: could not list versions for $function_name; skipped version pruning" >&2
    return 0
  fi
  # Numbered versions only ($LATEST excluded), highest first.
  numbered="$(tr -s '[:space:]' '\n' <<<"$versions_text" | grep -E '^[0-9]+$' | sort -rn || true)"
  # Everything after the newest $keep_versions is a candidate for deletion.
  candidates="$(tail -n +"$((keep_versions + 1))" <<<"$numbered")"

  while IFS= read -r version; do
    [[ -n "$version" ]] || continue
    if grep -qxF "$version" <<<"$protected"; then
      continue
    fi
    if ! aws lambda delete-function --function-name "$function_name" --qualifier "$version" --region "$region"; then
      echo "WARNING: could not delete $function_name version $version; pruned $deleted before stopping" >&2
      return 0
    fi
    deleted=$((deleted + 1))
  done <<<"$candidates"

  echo "Pruned $deleted old $function_name versions; kept newest $keep_versions and alias-referenced versions."
  return 0
}

prune_old_versions || echo 'WARNING: version pruning failed unexpectedly; the deploy itself succeeded' >&2
