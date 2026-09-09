# Changelog

## 0.3.2 — 2026-08-22

This is the first publishable release candidate for the current v0.3 line. It aggregates changes made after the historical `v0.3.1` snapshot; that tag remains immutable and its Draft Release was never published.

### Added

- Complete v0.3 command surface for projects, scripts, assets, prep, references, generation, queues, reviews, deliveries, and reference tests.
- Project inventory commands for members, costs, consumption records, generation history, failed tasks, and project-asset removal.
- Bundled `shortdrama-cli` Skill manifest and agent definition in every release artifact.

### Changed

- All production API calls use the current `/api/v1` service contract and strict `{ok,data}` response envelope.
- Authentication selects a bundled trusted environment (`prod`, `test`, or `dev`) instead of accepting arbitrary service URLs.
- Release validation is self-contained: five-platform artifacts, security scans, packaged CLI execution, runtime version, bundled Skill, checksums, and manifest are verified before publish.

### Fixed

- Dynamic API path segments are encoded independently without corrupting query strings.
- Release packages include the CA trust bundle required for HTTPS.
- CLI output redacts sensitive values and maps server rejection codes to stable non-zero exits.
- Windows and ANSI-sensitive contract tests no longer depend on the host terminal.

### Migration from 0.0.2-beta

The beta endpoints (`/models`, `*-generations`, `generation-tasks`, legacy `scripts*`, and `seedance-assets/*`) are retired. Install 0.3.2, log in with `shortdrama auth login --env <prod|test|dev>`, and use the commands documented in `docs/v030-command-api-matrix.md`. The CLI does not restore arbitrary `SHORTDRAMA_API_BASE` routing or add a permanent server compatibility layer for the beta surface.
