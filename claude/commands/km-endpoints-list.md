# /km-endpoints-list — List Komodo endpoints

List all Komodo Core endpoints registered with the `km-endpoints` skill:

```bash
bash ~/.claude/skills/km-endpoints/bin/list.sh
```

Output: one line per endpoint (`name  host`). There is no "active" endpoint — every `km` invocation selects its target via `km -p <name>`, so this is pure inventory.

If no endpoints are defined, prints an error pointing at `~/.claude/skills/km-endpoints/endpoints/`.
