---
name: km-container
description: Inspect Periphery Servers and raw containers with ps/inspect; perform a bounded start, restart, stop or destroy without redeploying the parent Stack. Use for container debugging, host inventory and explicit single-container operations, not durable Stack changes.
allowed-tools: Bash, Read
---

# Containers and Periphery Servers

Select the Core through `skill://container-management`; missing profile recovery belongs to `skill://km-endpoints`. Server and container names are scoped to that Core. Homelab's `Local` is moat-app1 / VM 110 and `browser` is VM 104; rediscover rather than reusing those names on trading.

## Locate the container and its parent

```bash
core=homelab
km -p "$core" ls servers
km -p "$core" ps -a
```

Choose `server` and `container` from the results, then inspect the exact host/name pair:

```bash
km -p "$core" ps -a -s "$server"
km -p "$core" inspect "$container" -s "$server" -u
km -p "$core" inspect "$container" -s "$server" -m
km -p "$core" ls stacks -a -s "$server" -f json
```

`ps` without `-a` hides stopped containers. `inspect` without `-s` can print multiple same-named containers across hosts. State (`-u`) and mounts (`-m`) are useful first reads; full inspect or config (`-c`) may contain environment secrets, so keep sensitive output out of reports.

Use container labels/config and the Stack inventory to establish its parent project and service. A raw container is not the source of its Compose declaration. For image/config rollout, service-level deploy or normal project restart, use `skill://km-stack` instead. A legacy Deployment is a separate Komodo resource, not a reason to create new Deployments in place of Stacks.

## Perform only the intended container operation

These are alternatives after preflight:

```bash
km -p "$core" x start-container "$server" "$container"
km -p "$core" x restart-container "$server" "$container"
km -p "$core" x stop-container "$server" "$container"
km -p "$core" x destroy-container "$server" "$container"
```

Use raw operations for an explicitly bounded container intervention, not to bypass the parent's declaration workflow. Before stop/destroy, establish downtime and mount/writable-layer impact. Destroy requires explicit authorization and does **not** remove the parent Stack record; a later Stack deploy can recreate the container. Clean project teardown belongs to `km-stack`.

Whole-server operations affect unrelated projects and shared dependencies. Do not substitute them for a single-container request; establish all affected workloads and explicit host-wide authorization before using that command family.

## Verify and recover

- Read the execution's terminal result, then repeat the scoped `ps -a` and state inspect. Start/restart should reach the expected running/health state; stop should leave the expected stopped state; destroy should leave the target absent without affecting sibling containers.
- Exercise the affected application's real workflow and persistence after start/restart. Check the parent Stack view too: raw runtime state and resource state can diverge.
- If the container is missing, check stopped containers and the parent Stack before recreating anything. If the operation fails, inspect its logs, mounts and parent configuration; do not broaden to all containers or destroy/recreate as a blind retry.
- If recovery requires a declaration/image change or recreation, return to the owning Stack workflow rather than hand-building a replacement container.
