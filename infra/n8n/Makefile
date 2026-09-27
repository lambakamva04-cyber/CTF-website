# Shortcuts. Everything here just calls docker compose or a script in scripts/,
# so you never have to use make if you'd rather type the commands out.
#
#   make setup     first-time install
#   make tunnel    publish it through Cloudflare
#   make status    is everything working?

.DEFAULT_GOAL := help
SHELL := /bin/bash

# Use sudo for docker only if this user can't reach the daemon directly.
DOCKER := $(shell docker info >/dev/null 2>&1 && echo docker || echo sudo docker)

.PHONY: help setup tunnel up down restart logs status backup restore update shell pull config perms

help: ## Show this help
	@echo
	@echo "  n8n behind Cloudflare Tunnel"
	@echo
	@grep -E '^[a-z-]+:.*?## .' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "    \033[1m%-10s\033[0m %s\n", $$1, $$2}'
	@echo

setup: ## First-time install: Docker, .env, encryption key, start n8n
	@./scripts/bootstrap.sh

tunnel: ## Install cloudflared and publish n8n through Cloudflare
	@./scripts/setup-tunnel.sh

up: ## Start n8n
	@$(DOCKER) compose up -d

down: ## Stop n8n (data is kept)
	@$(DOCKER) compose down

restart: ## Restart n8n
	@$(DOCKER) compose restart

logs: ## Follow the logs (ctrl-c to stop)
	@$(DOCKER) compose logs -f --tail 100 n8n

status: ## Check every part of the stack and report what's broken
	@./scripts/status.sh

backup: ## Back up workflows, credentials and the encryption key
	@./scripts/backup.sh

restore: ## Restore a backup:  make restore FILE=backups/n8n-....tar.gz
	@test -n "$(FILE)" || { echo "usage: make restore FILE=backups/n8n-....tar.gz"; exit 1; }
	@./scripts/backup.sh --restore "$(FILE)"

update: ## Update n8n, with a backup and automatic rollback
	@./scripts/update.sh

shell: ## Open a shell inside the n8n container
	@$(DOCKER) compose exec n8n /bin/sh

config: ## Show the fully resolved compose configuration
	@$(DOCKER) compose config

perms: ## Re-apply the intended file permissions
	@chmod 600 .env 2>/dev/null && echo "  .env            600" || true
	@chmod 700 scripts/*.sh && echo "  scripts/*.sh    700"
	@test -d backups && chmod 700 backups && chmod 600 backups/* 2>/dev/null; true
	@test -d backups && echo "  backups/        700, contents 600" || true
	@test -d /etc/cloudflared && sudo chmod 700 /etc/cloudflared \
	  && sudo find /etc/cloudflared -type f -exec chmod 600 {} + \
	  && echo "  /etc/cloudflared 700, contents 600" || true
