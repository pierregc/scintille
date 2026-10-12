# Local equivalents of the CI checks and deploys, for when GitHub Actions is unavailable.
# `make` lists the targets. See docs/local-ci.md.
SHELL := /bin/bash
.DEFAULT_GOAL := help

SHA := $(shell git rev-parse HEAD)
OWNER := pierregc
PACKAGES := scintille-ingest scintille-pipelines
COMPOSE_LOCAL := docker compose -f infra/compose/compose.local.yaml
VPS_HOST ?= VPS_HOST
VPS_USER ?= deploy
VPS_KEY ?= $(HOME)/.ssh/scintille_deploy
# Where the contract check diffs from; CI uses the PR base.
BASE ?= origin/main

.PHONY: help check data web lake smoke rollback render secrets \
	deploy-web deploy-images deploy-vps deploy guard-main

help:
	@awk -F':.*## ' '/^[a-z-]+:.*## /{printf "  make %-14s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

check: secrets data web rollback ## secrets + data + web + rollback, the checks every change needs
data: ## ruff, format, mypy, contract, pytest
	cd data && uv sync --frozen && uv run ruff check && uv run ruff format --check && uv run mypy
	cd data && uv run scintille-contract check --base $(BASE) && uv run pytest
web: ## astro check, eslint, vitest, build, seo, wrangler dry run
	cd web && pnpm install --frozen-lockfile && pnpm check && pnpm lint && pnpm test && pnpm build \
		&& pnpm test:seo && pnpm exec wrangler deploy --dry-run --x-auto-create=false
lake: ## local Iceberg catalog (Docker), migrate twice, pytest -m lake
	docker compose up -d --wait lakekeeper lake-db && docker compose run --rm lake-init
	cd data && uv sync --frozen && uv run scintille-lake migrate && uv run scintille-lake migrate | tee /tmp/lake-second.log
	grep -q "up to date" /tmp/lake-second.log
	cd data && uv run pytest -m lake
	docker compose down
smoke: ## VPS compose stack built and run locally (Docker, several GB)
	$(COMPOSE_LOCAL) up -d --build --wait dagster-webserver dagster-daemon ingest lake-writer clouds lakekeeper
	$(COMPOSE_LOCAL) run --rm lake-init
	curl -sf http://127.0.0.1:3000/server_info
	$(COMPOSE_LOCAL) exec -T dagster-daemon dagster-daemon liveness-check
	test "$$($(COMPOSE_LOCAL) exec -T dagster-daemon id -u)" = 10001
	$(COMPOSE_LOCAL) down -v
rollback: ## deploy.sh rolls back a failing release (Docker)
	infra/compose/test_deploy.sh
secrets: ## gitleaks on the full history (brew install gitleaks)
	gitleaks git --redact --no-banner
render: ## two SwiftShader renders of the fixture hour must match frame for frame
	scripts/local-render.sh

guard-main:
	@test "$$(git rev-parse --abbrev-ref HEAD)" = main || { echo "deploy from main only" >&2; exit 1; }
	@test -z "$$(git status --porcelain)" || { echo "working tree is not clean" >&2; exit 1; }
	@git fetch -q origin main && test "$$(git rev-parse HEAD)" = "$$(git rev-parse origin/main)" \
		|| { echo "main is not at origin/main" >&2; exit 1; }

deploy-web: guard-main ## build and wrangler deploy to scintille.app (wrangler login)
	cd web && pnpm install --frozen-lockfile && pnpm build \
		&& pnpm exec wrangler deploy --x-auto-create=false --message "$(SHA)"
deploy-images: guard-main ## build linux/amd64 images and push to GHCR (docker login ghcr.io, write:packages)
	@for p in $(PACKAGES); do \
		docker buildx build --platform linux/amd64 --push -f data/Dockerfile --build-arg PACKAGE=$$p \
			-t ghcr.io/$(OWNER)/$$p:$(SHA) -t ghcr.io/$(OWNER)/$$p:main data || exit 1; \
	done
deploy-vps: guard-main ## roll the pushed images out on the VPS, with rollback
	ssh -i $(VPS_KEY) $(VPS_USER)@$(VPS_HOST) "mkdir -p /srv/scintille/releases/$(SHA)"
	scp -i $(VPS_KEY) infra/compose/compose.yaml $(VPS_USER)@$(VPS_HOST):/srv/scintille/releases/$(SHA)/
	scp -i $(VPS_KEY) infra/compose/deploy.sh $(VPS_USER)@$(VPS_HOST):/srv/scintille/
	ssh -i $(VPS_KEY) $(VPS_USER)@$(VPS_HOST) "/srv/scintille/deploy.sh $(SHA)"
deploy: deploy-web deploy-images deploy-vps ## all three
