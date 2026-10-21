.PHONY: help install dev build test clean lint format hooks

# Default target
.DEFAULT_GOAL := help

# Color definitions
BLUE := \033[0;34m
GREEN := \033[0;32m
YELLOW := \033[0;33m
NC := \033[0m # No Color

help: ## Show help message
	@echo '$(BLUE)CreatorWeave - Commands$(NC)'
	@echo ''
	@echo '$(GREEN)Quick Start:$(NC)'
	@echo '  make setup         - First-time setup (install all dependencies)'
	@echo '  make setup-hooks   - Install git pre-commit hooks'
	@echo '  make dev           - Start development server'
	@echo '  make build         - Build all projects (extension + frontend)'
	@echo '  make test          - Run all tests'
	@echo '  make clean         - Clean build artifacts'
	@echo ''
	@echo '$(GREEN)Code Quality:$(NC)'
	@echo '  make lint          - Run ESLint checks'
	@echo '  make lint-fix      - Fix linting issues automatically'
	@echo '  make format        - Format all code (TypeScript)'
	@echo '  make typecheck     - Run TypeScript type check'
	@echo ''
	@echo '$(GREEN)Individual Commands:$(NC)'
	@echo '  make install-deps  - Install pnpm dependencies only'
	@echo '  make build-web     - Build frontend'
	@echo '  make test-web      - Run frontend tests'

setup: ## First-time setup (install all dependencies)
	@node scripts/setup.mjs

setup-hooks: ## Install git pre-commit hooks
	@node scripts/setup-hooks.mjs

install: install-deps ## Alias for install-deps

install-deps: ## Install pnpm dependencies
	@echo '$(BLUE)Installing dependencies...$(NC)'
	@cd web && pnpm install
	@cd browser-extension && pnpm install
	@echo '$(GREEN)✅ Dependencies installed!$(NC)'

dev: ## Start development server
	@node scripts/dev.mjs

build: ## Build all projects (extension + frontend)
	@node scripts/build.mjs


build-web: ## Build frontend only
	@echo '$(BLUE)Building frontend...$(NC)'
	@cd web && pnpm run build
	@echo '$(GREEN)✅ Frontend built!$(NC)'

build-extension: ## Build browser extension only
	@echo '$(BLUE)Building browser extension...$(NC)'
	@cd browser-extension && ([ -d node_modules ] || pnpm install) && pnpm run build
	@echo '$(GREEN)✅ Browser extension built!$(NC)'

test: ## Run all tests
	@node scripts/test.mjs


test-web: ## Run frontend tests
	@echo '$(BLUE)Running frontend tests...$(NC)'
	@cd web && pnpm test
	@echo '$(GREEN)✅ Frontend tests passed!$(NC)'

lint: ## Run linters (ESLint)
	@echo '$(BLUE)Running linters...$(NC)'
	@$(MAKE) lint-web
	@echo '$(GREEN)✅ All lint checks passed!$(NC)'

lint-fix: ## Fix linting issues automatically
	@echo '$(BLUE)Fixing linting issues...$(NC)'
	@$(MAKE) lint-web-fix
	@echo '$(GREEN)✅ Linting issues fixed!$(NC)'

lint-web: ## Run frontend linter (ESLint)
	@echo '$(BLUE)Running ESLint...$(NC)'
	@cd web && pnpm run lint
	@echo '$(GREEN)✅ ESLint checks passed!$(NC)'

lint-web-fix: ## Fix frontend linting issues
	@echo '$(BLUE)Fixing ESLint issues...$(NC)'
	@cd web && pnpm run lint:fix
	@echo '$(GREEN)✅ ESLint issues fixed!$(NC)'

format: ## Format all code (TypeScript + CSS)
	@echo '$(BLUE)Formatting code...$(NC)'
	@$(MAKE) fmt-web
	@echo '$(GREEN)✅ All code formatted!$(NC)'

fmt-web: ## Format frontend code
	@echo '$(BLUE)Formatting frontend code...$(NC)'
	@cd web && pnpm run format
	@echo '$(GREEN)✅ Frontend code formatted!$(NC)'

typecheck: ## Run TypeScript type check
	@echo '$(BLUE)Running TypeScript type check...$(NC)'
	@cd web && pnpm run typecheck
	@cd browser-extension && pnpm run typecheck
	@echo '$(GREEN)✅ Type check passed!$(NC)'

clean: ## Clean build artifacts
	@node scripts/clean.mjs

hooks: ## Alias for setup-hooks
	@$(MAKE) setup-hooks

