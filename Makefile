.DEFAULT_GOAL := help
NODE ?= node
NPM ?= npm

.PHONY: help dev-init dev dev-down dev-logs dev-status dev-native dev-session smoke import-sites install check check-image-config

help:
	@printf '%s\n' \
	  'make dev          Build and start Docker + SQLite at http://localhost:3000' \
	  'make smoke        Verify HTTP, auth, ingest, queue consumption and queries' \
	  'make import-sites FILE=/path/sites.sql  Import a sites-only D1 export' \
	  'make dev-session  Print a local browser login command (no OAuth needed)' \
	  'make dev-logs     Follow development container logs' \
	  'make dev-status   Show development container status' \
	  'make dev-down     Stop development containers; preserve SQLite data' \
	  'make install      Install dependencies for native development/checks' \
	  'make dev-native   Build and run Node with .env.local in the foreground' \
	  'make check-image-config  Verify scoring Secret updates in Docker images' \
	  'make check        Run type checks and SQLite integration tests'

dev-init:
	@$(NODE) scripts/local-dev.mjs init

dev: dev-init
	@$(NODE) scripts/local-dev.mjs compose up -d --build --wait --wait-timeout 90
	@$(NODE) scripts/local-dev.mjs url

dev-down:
	@$(NODE) scripts/local-dev.mjs compose down

dev-logs:
	@$(NODE) scripts/local-dev.mjs compose logs -f --tail 100 app

dev-status:
	@$(NODE) scripts/local-dev.mjs compose ps

dev-session: dev-init
	@$(NODE) scripts/local-dev.mjs session

smoke: dev-init
	@$(NODE) scripts/local-dev.mjs smoke

import-sites: export PVUV_IMPORT_FILE = $(FILE)
import-sites:
	@$(NODE) scripts/local-dev.mjs import-sites

install:
	$(NPM) ci

check-image-config:
	$(NODE) scripts/check-scoring-cache.mjs

dev-native: dev-init
	$(NPM) run build:server
	@$(NODE) scripts/local-dev.mjs native

check:
	$(NODE) --test scripts/tests/import-sites.test.mjs
	$(NPM) run typecheck
	$(NPM) run typecheck:server
	$(NPM) run test:server
