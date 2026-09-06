---
name: km-database
description: Back up, restore, prune backups or copy Komodo Core metadata databases, distinct from application databases and Docker volumes. Use before Core maintenance or migration; verify database connection targets and explicit overwrite authorization.
allowed-tools: Bash, Read
---

# Komodo metadata database operations

This is Komodo's own resource/user/control-plane state, not application database contents, Compose bind mounts or Docker volumes. The homelab deployment uses Postgres backing FerretDB. A Core metadata backup does not back up the applications its Stacks run.

## Establish the actual database target

1. Select the intended Core using `skill://container-management`; `homelab` and `trading` are independent Cores. Profile/inventory recovery is `skill://km-endpoints`.
2. Inspect sanitized CLI configuration and the owning IaC database/backup configuration. **Do not assume `-p` alone proves which database a `db` utility connects to.** Establish its database URI/address/name, backup path and runtime location before invoking it; the Core API profile and direct database connection are distinct configuration concerns.
3. Capture the Core's pre-maintenance resource inventory and identify a recoverable backup destination:

   ```bash
   core=homelab
   km -p "$core" config
   km -p "$core" ls servers -f json
   km -p "$core" ls stacks -a -f json
   km -p "$core" db backup --help
   km -p "$core" db restore --help
   km -p "$core" db copy --help
   ```

Keep database credentials out of output and command history; use the existing IaC/secret-injection path. Missing database connectivity is a tooling/configuration gap, not a request for the user to paste a URI/password. Do not hand-edit endpoint-rendered config to add settings that the next render will discard.

## Backup before maintenance

Back up before a Core Compose redeploy, FerretDB/Postgres upgrade or host migration:

```bash
km -p "$core" db backup
```

`db backup` creates compressed files organized by backup time. Its help gives `/backups` as the default folder; verify where that path resolves and its retention/storage configuration rather than treating it as a confirmed host path. `backups_folder` and `max_backups` must be checked in effective configuration, not assumed from historical values.

The Core execution alternative is:

```bash
km -p "$core" x backup-core-database
```

Choose the supported backup path for the deployment; do not run both blindly. For an execution request, wait for its terminal result. Check the resulting timestamped artifact, location, completeness/readability and access from the intended recovery environment. A success banner without a recoverable artifact is insufficient; use an isolated restore rehearsal when establishing backup recoverability.

## Restore a specific backup

Restore overwrites current metadata. Establish the destination DB, selected artifact, compatibility and maintenance/recovery plan, take a fresh pre-restore backup and obtain explicit overwrite authorization.

```bash
# Set backup_folder to the verified timestamped folder, not a guessed value.
km -p "$core" db restore --restore-folder "$backup_folder"
```

Without `--restore-folder`, the CLI selects the most recent backup. Select explicitly so a newly created safety backup does not silently change the intended restore. Set the verified backups root with `--backups-folder` when it differs from the configured/default location. Keep confirmation prompts.

## Retention cleanup and migration

- **Prune backups:** `km -p "$core" db prune` removes excess backups according to configured `max_backups`. Inspect the backup inventory and retention setting, preserve required recovery points, and obtain deletion authorization before running. This prunes backups, not Docker artifacts or application data.
- **Copy:** `km -p "$core" db copy` copies to another running database. The target is configured as a database URI/address/name, **not a second `km` profile**. Its local help exposes target connection options; resolve source and destination from IaC and the installed configuration before use. Back up the destination and confirm overwrite scope. Never infer the target from an imagined future Core, and never put a secret-bearing `--uri` or `--password` in transcript-visible commands.

A metadata copy does not migrate application volumes or deploy workloads. Inspect copied Server/Stack references and automation before allowing the new Core to act on existing hosts; avoid two controllers unintentionally operating the same workloads.

## Verify and recover

After restore/copy, confirm the intended Core can authenticate and read its database, then compare Servers and all Stacks with the captured/expected inventory using the same read-only commands above. Check relevant users, permissions and orchestration records too. Inspect workloads without triggering a blanket redeploy; application state may have remained unchanged throughout the metadata operation.

On failure, preserve artifacts and terminal logs, establish whether the DB is unchanged or partially restored, and follow the maintenance recovery plan. Do not blindly repeat a destructive copy/restore, prune the safety backup or reconnect a second Core to production hosts to test whether it worked.
