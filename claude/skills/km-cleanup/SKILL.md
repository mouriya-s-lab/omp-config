---
name: km-cleanup
description: Reclaim Docker disk on a Komodo Periphery host with scoped prune/delete operations. Use for disk-full, unused images/build caches, networks or volumes; inspect dependencies and obtain destructive-impact authorization before removal.
allowed-tools: Bash, Read
---

# Docker cleanup through Komodo

Every prune/delete here is destructive. Establish the exact Core, Server and impact, then obtain explicit authorization before execution. Do not treat a generic “disk full” report as permission to delete volumes.

Select the Core using `skill://container-management`; profile recovery belongs to `skill://km-endpoints`.

## Inspect what occupies the host

```bash
core=homelab
km -p "$core" ls servers
# Set server from that inventory.
km -p "$core" ps -a -s "$server"
km -p "$core" ls stacks -a -s "$server" -f json
```

Inspect mounts for relevant containers with `km -p "$core" inspect "$container" -s "$server" -m`. Include stopped containers and down Stacks: data and rollback images may still be needed. Use the Komodo Server UI/API's Docker artifact and disk-usage views to establish actual space use, references and cleanup candidates; a container listing alone is not a volume/image inventory. For a missing CLI read use `skill://km-api`, not guessed commands or direct host mutation.

Record before-state disk usage, candidate names and known owners. For volumes, establish the data owner, recoverable backup and restore path. “Unreferenced by a container” does not mean “unneeded by a stopped/removed workload”. If ownership or backups cannot be established, do not delete that data.

## Choose a narrow cleanup

Use installed command help to check semantics if versions differ. The inspected CLI describes these scopes:

| Command | Impact |
|---|---|
| `km -p "$core" x prune-images "$server"` | Runs `docker image prune -a -f`: all images not referenced by containers, not merely dangling images; can remove rollback/offline-start images |
| `km -p "$core" x prune-docker-builders "$server"` | Removes builder cache; subsequent builds may need to rebuild/download |
| `km -p "$core" x prune-buildx "$server"` | Removes buildx cache; inspect builders/cache ownership first |
| `km -p "$core" x prune-containers "$server"` | Removes stopped containers, including their writable-layer state and inspect/log evidence |
| `km -p "$core" x prune-networks "$server"` | Removes unused networks; check intentionally idle networks |
| `km -p "$core" x prune-volumes "$server"` | Runs `docker volume prune -a -f`: unused named as well as anonymous volumes can contain persistent data |
| `km -p "$core" x prune-system "$server"` | Runs `docker system prune -a -f --volumes`; broad removal including volumes, not a safe shorthand for image cleanup |

For disk pressure, start with the verified image/cache candidates, measure reclaimed space, and stop when the goal is met. Stopped-container and network pruning need their own justification; volume/system pruning is a last resort with explicit per-host data-loss authorization. Do not automatically escalate through the table.

When a specific artifact is the intended target, choose its exact name rather than host-wide pruning:

```bash
km -p "$core" x delete-image "$server" "$image"
km -p "$core" x delete-network "$server" "$network"
km -p "$core" x delete-volume "$server" "$volume"
```

These are alternatives after inventory and authorization, not a script to execute together. Keep interactive confirmation prompts; do not add `-y` to avoid deciding scope.

## Verify and recover

1. Inspect the terminal execution result, removed-artifact report and reclaimed space; compare host disk usage to the before-state. An accepted execution is not proof of reclamation.
2. Repeat the scoped container/Stack inventory and check the affected applications still perform their real workflows. Confirm only intended artifacts disappeared.
3. If nothing was reclaimed, investigate the actual storage consumer; do not jump to volume/system pruning. If an artifact is in use or deletion fails, inspect its dependents rather than force-removing them.
4. Pruning has no general undo. Re-pull an image or recreate a network only through the owning deployment path; lost volume data requires its established restore procedure. Do not claim recreation recovers deleted data.
