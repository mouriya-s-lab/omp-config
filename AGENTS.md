# Repository Agent Guide

## Scope

This repository contains the reviewable, portable slice of OMP configuration; it is not a backup of the live `~/.omp/agent` tree. Runtime state, databases, sessions, caches, plugin installs, and credentials do not belong in the repository.

## Read only the relevant source

- Project inventory, architecture, and migration details: [README.md](README.md).
- Exact side effects and file contracts: [update-omp](.omp/commands/update-omp.md), [sync-omp-config](.omp/commands/sync-omp-config.md), and [migrate-omp-keys](.omp/commands/migrate-omp-keys.md).
- Before changing extensions, structured OMP configuration, or custom agent definitions, read [agent/CODING_STANDARDS.md](agent/CODING_STANDARDS.md). For custom agent definitions, also read `agent/agents/README.txt`.
- For a task requiring interaction with a visible host window, use the installed `computer-use` skill; keep its platform-specific control and safety procedure there rather than duplicating it here.

## Side effects and data safety

- `/update-omp` writes to the live OMP profile; `/sync-omp-config` writes to this repository and never updates the machine. Follow the corresponding command contract before either operation.
- Never copy the whole `agent/` directory; use the documented allowlist. Never commit runtime data or credentials.
- Move credentials only through `/migrate-omp-keys`. It copies only the `auth_credentials` table, requires confirmation, and must not print credential data.
- Do not overwrite app-managed extensions marked `@orca-managed-pi-extension` or `marker: _otty`.

## Verification boundary

This repository has no formal automated test suite. Config parsing does not prove extension behavior; extension changes require the runtime exercise described in [agent/CODING_STANDARDS.md](agent/CODING_STANDARDS.md). Do not claim runtime verification unless the changed path was actually exercised.

## Change lifecycle

Agent definition edits apply on the next spawn. `APPEND_SYSTEM.md`, extensions, and plugins apply after restarting OMP; see the command contract and README for details.
