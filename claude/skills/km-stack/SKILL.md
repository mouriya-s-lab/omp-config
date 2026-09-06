---
name: km-stack
description: >-
  Inspect and operate live Komodo Compose Stacks: deploy, pull, restart, stop or destroy. Check repo/file_contents authority before config changes; repo-backed declarations belong to the owning workload repo and ResourceSync workflow.
allowed-tools: Bash, Read
---

# Komodo Stack operations

A Stack is a Compose project managed by Komodo. For Core selection and resource relationships use `skill://container-management`; for missing profiles use `skill://km-endpoints`. Examples select homelab explicitly; use trading when that is the established target.

## Inspect the target and declaration source

```bash
core=homelab
km -p "$core" ls stacks -a -f json
```

The default listing hides down Stacks. Resolve the exact Stack and Server from this inventory, not a memorized service list. Inspect its `repo`, `branch`, file path and `file_contents` configuration in the resource details; if the listing does not expose full config, use the Komodo UI or a version-matched `GetStack` read through `skill://km-api`.

- **`repo` set, `file_contents=false`:** the owning workload repo (`komodo/syncs/` and `stacks/`) is declaration authority. Change it there and run its ResourceSync workflow (`skill://local-cicd`, `skill://km-gitops`). Direct live config edits are not a substitute. This skill handles inspection, bounded retry and lifecycle operations.
- **`repo` empty, `file_contents=true`:** the explicit legacy declaration lives in the owning IaC/control-plane repo. Change that source; do not copy this pattern for a new Stack.
- **Neither shape is established:** inspect ownership before changing config. Do not guess which field wins.

Keycloak/Forgejo are pve-vctcn Compose services on vctcn-app1 / VM 180, not homelab or trading Stacks. Historical down records do not authorize deploying them here.

## Choose the smallest action that meets the request

Set `stack` to the exact name found above. These commands are alternatives, not a sequence to run wholesale.

| Need | Command | Distinction |
|---|---|---|
| Routine reapply when Compose content changed | `km -p "$core" x deploy-stack-if-changed "$stack"` | Avoids unnecessary redeploys; do not use this as proof a new mutable image tag was pulled |
| Deploy/redeploy the declared project | `km -p "$core" x deploy-stack "$stack"` | Applies Stack configuration |
| Pull configured images | `km -p "$core" x pull-stack "$stack"` | Pulling alone does not replace running containers; deploy if rollout is intended |
| Restart existing services | `km -p "$core" x restart-stack "$stack"` | Not a declaration or image rollout |
| Start existing stopped services | `km -p "$core" x start-stack "$stack"` | Does not stand in for applying changed Compose |
| Stop the project | `km -p "$core" x stop-stack "$stack"` | Intentional downtime |
| Tear down project runtime | `km -p "$core" x destroy-stack "$stack"` | Destructive; inspect mounts/data consequences and obtain explicit scoped authorization |

For a confirmed non-Swarm Compose Stack, a service-scoped deployment is available:

```bash
# stack and service come from the inspected project.
km -p "$core" x deploy-stack "$stack" "$service"
```

This is a **deployment**, not just a restart. Service filtering is ignored for Swarm-mode Stacks; do not claim bounded service scope there. For raw-container exceptions use `skill://km-container`. Avoid wildcard/batch operations until every matched project and its impact are explicitly in scope.

## Verify and recover

1. Read the execution's terminal result and error/log details in CLI output or Komodo UI. An accepted request is not completion.
2. Re-read the Stack and its Server's containers:

   ```bash
   km -p "$core" ls stacks -a -n "$stack" -f json
   km -p "$core" ps -a -s "$server"
   ```

   Set `server` from the inspected Stack. Check expected service state and actual image/version; for stop/destroy, check the intended stopped/absent runtime instead of expecting “running”.
3. For deploy/restart, execute the service's real user/API workflow and check persistence/downstream effects. For a declaration change, also confirm the live repo/branch/file path matches the owning revision. Container state alone is insufficient.
4. On failure, inspect terminal logs and current state before retrying. Fix declaration errors in the owning repo, complete its sync, then retry only the affected Stack. Do not delete containers, rewrite live config or roll back unrelated projects to suppress the symptom. Any rollback must use an established revision/image and the same authority path.

A runtime teardown and deletion of a Komodo resource/declaration are different operations. If permanent removal is intended, update the owning declaration through its workflow rather than leaving drift for the next sync to reconcile.
