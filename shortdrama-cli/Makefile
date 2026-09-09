UV ?= uv
BINARY_NAME ?= shortdrama-cli

.PHONY: help install sync start test security-test build package binary binary-dir clean-build clean

help:
	@printf "shortdrama-cli commands:\n"
	@printf "  make install              Install project dependencies with uv\n"
	@printf "  make start                Show the shortdrama CLI help\n"
	@printf "  make test                 Run contract tests\n"
	@printf "  make security-test        Run Security Action contract tests\n"
	@printf "  make build                Build wheel and source distribution into dist/\n"
	@printf "  make package              Alias for make build\n"
	@printf "  make binary               Build a one-file executable into dist/bin/\n"
	@printf "  make binary-dir           Build a faster-starting app directory into dist/app/\n"
	@printf "  make clean-build          Remove package build artifacts\n"
	@printf "  make clean                Remove local run outputs and caches\n"

install sync:
	$(UV) sync

start:
	$(UV) run shortdrama-cli --help

test:
	$(UV) run pytest -q


security-test:
	$(UV) run --frozen python -m pytest -q tests/test_security_action.py
build package: clean-build
	$(UV) build

binary: clean-build
	$(UV) run pyinstaller --onefile --name $(BINARY_NAME) --collect-data shortdrama_cli --collect-data certifi --distpath dist/bin --workpath build/pyinstaller --specpath build/pyinstaller src/shortdrama_cli/__main__.py

binary-dir: clean-build
	$(UV) run pyinstaller --onedir --name $(BINARY_NAME) --collect-data shortdrama_cli --collect-data certifi --distpath dist/app --workpath build/pyinstaller --specpath build/pyinstaller src/shortdrama_cli/__main__.py

clean-build:
	rm -rf dist build *.egg-info src/*.egg-info

clean:
	rm -rf runs .pytest_cache
