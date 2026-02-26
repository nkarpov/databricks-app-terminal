#!/bin/bash
# OAuth token exchange for Databricks App service principal.
# Falls back to DATABRICKS_TOKEN env var if OAuth vars aren't set.
if [ -n "$DATABRICKS_CLIENT_ID" ] && [ -n "$DATABRICKS_CLIENT_SECRET" ]; then
    curl -s --request POST \
        --url "https://${DATABRICKS_HOST}/oidc/v1/token" \
        --user "${DATABRICKS_CLIENT_ID}:${DATABRICKS_CLIENT_SECRET}" \
        --data 'grant_type=client_credentials&scope=all-apis' \
        | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])"
else
    echo "${DATABRICKS_TOKEN}"
fi
