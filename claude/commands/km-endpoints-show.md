# /km-endpoints-show — Print one Komodo endpoint's credentials

Print a named Komodo endpoint's `NAME`, `HOST`, `KEY`, `SECRET` as `KEY=value` lines (suitable for `eval $(...)` when calling the Komodo REST API by hand).

Usage: `/km-endpoints-show <name>` — `<name>` must match a file in `~/.claude/skills/km-endpoints/endpoints/`.

```bash
bash ~/.claude/skills/km-endpoints/bin/show.sh $ARGUMENTS
```

There is no "active" endpoint — every caller must pass `<name>` explicitly, mirroring `km -p <name>`. If `<name>` is missing or doesn't exist, the script lists available endpoints and exits non-zero.
