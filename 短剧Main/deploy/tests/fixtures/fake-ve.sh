#!/usr/bin/env bash
set -euo pipefail

if [[ "${FAKE_VE_MODE:-ok}" == "missing" ]]; then
  printf '%s\n' '{"ResponseMetadata":{"RequestId":"test"},"Result":{"SecretValue":"{\"ARK_API_KEY\":\"kms-ark\",\"TOS_ACCESS_KEY\":\"kms-tos-ak\",\"TOS_SECRET_KEY\":\"kms-tos-sk\",\"POSTGRES_PASSWORD\":\"kms-db\"}"}}'
  exit 0
fi

printf '%s\n' '{"ResponseMetadata":{"RequestId":"test"},"Result":{"SecretValue":"{\"ARK_API_KEY\":\"kms-ark\",\"TOS_ACCESS_KEY\":\"kms-tos-ak\",\"TOS_SECRET_KEY\":\"kms-tos-sk\",\"POSTGRES_PASSWORD\":\"kms-db\",\"MILVUS_PASSWORD\":\"kms-milvus\"}"}}'
