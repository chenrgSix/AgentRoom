#!/usr/bin/env bash

# This list is the closed source-build Central payload. Packaging and
# verification source it from the exact checked-out Release commit.
central_source_paths=(
  .dockerignore
  Dockerfile
  compose.yaml
  package.json
  package-lock.json
  LICENSE
  NOTICE
  COMMERCIAL-LICENSE.md
  TRADEMARKS.md
  apps/server
  apps/web
  packages/contracts
  deploy/Caddyfile
  deploy/app.caddy
  deploy/.env.example
  deploy/http
  deploy/tls
  scripts/compose-backup.sh
  scripts/compose-restore.sh
  ops/convenewirectl
)
