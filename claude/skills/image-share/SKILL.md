---
name: image-share
description: Upload local image evidence to img.237575.xyz for a public URL usable in GitHub PRs. The installed helper resolves auth from env or pve-vctcn SOPS; callers supply the image path, not credentials. Not for non-image assets or permanent archival.
---

# image-share

Upload screenshots for PR bodies, comments, or reviews across the operator's repos. Anyone with the URL can read the image: inspect it for secrets, private data, and unintended screen content before upload. Hosting is operator-owned convenience storage, not an archival or availability guarantee.

## Installed call path

```bash
~/.claude/skills/image-share/scripts/upload.sh [-m|--markdown] <path-to-image>
```

The installed `scripts/upload.sh` is the executable upload implementation, not a wrapper or a delegate to another skill directory. Invoke it directly through the installed skill path above. The npx-managed package carries the helper; credentials and response-cache files remain external. If the helper is missing or not executable, repair the skill installation rather than moving credentials or adding another wrapper.

Success writes exactly one stdout line: a bare `https://img.237575.xyz/media/<key>` URL, or `![](<URL>)` with `-m`/`--markdown`. Diagnostics go to stderr. Exit codes: `0` success (also `--help`), `1` runtime failure, `2` usage error. The exit code, not a captured string, decides upload success.

```bash
# Use the screenshot path produced by your browser/evidence workflow.
if URL=$(~/.claude/skills/image-share/scripts/upload.sh ./evidence/screenshot.png); then
  printf '%s\n' "$URL"
  curl -fsSI "$URL"
fi

# Multiple screenshots; stop rather than embedding a failed upload.
for f in ./evidence/screens/*.png; do
  ~/.claude/skills/image-share/scripts/upload.sh -m "$f" || break
done
```

Before embedding, verify anonymous HTTP 200 with an image content type and view the returned image. An upload API success alone does not prove public rendering. Keep the URL with the evidence so a duplicate upload can reuse it. Use `writing-pr` for PR evidence placement; these externally hosted images do not require a repository SHA pin. Images committed to a repo still follow its SHA-pin rule.

## Authentication and dependencies

The helper resolves the password in order:

1. Nonempty `ZERO721_PASSWORD` in the environment.
2. Nonempty `TF_VAR_zero721_admin_password` from an already-loaded IaC environment.
3. SOPS-decrypt `pve-vctcn/_shared/secrets/secrets.yml` and select the nonempty string `zero721_admin_password` with Mike Farah `yq`.

It does not use Keychain or prompt for credentials. Follow `credentials-belong-in-iac`: resolve the existing local IaC/age setup without exposing plaintext; do not ask the user to paste a password, print decrypted files, or create a second secret store.

| Variable | Default / purpose |
|---|---|
| `ZERO721_BASE_URL` | `https://img.237575.xyz` |
| `ZERO721_EMAIL` | `mouriya@vctcn.local` |
| `ZERO721_PASSWORD` | Explicit environment override from an authorized secret source |
| `TF_VAR_zero721_admin_password` | Existing pve-vctcn environment value |
| `ZERO721_IAC_REPO` | `/Users/mouriya/Ext/code/pve-vctcn` |
| `ZERO721_SECRETS_FILE` | `$ZERO721_IAC_REPO/_shared/secrets/secrets.yml` |

All paths require `curl` and `jq`; SOPS fallback additionally requires `sops`, Mike Farah `yq`, and a usable age identity. Missing file/tool/key is a local integration failure, not a reason to hand-feed credentials.

## Requests, observations, and recovery

The helper logs in per invocation with `POST /api/auth/login`, JSON `{name: <email>, password_raw: <password>}`, then uploads via `PUT /api/media/insert?name=<encoded filename>` with Bearer auth and multipart `file`. It accepts either a raw key or JSON `{key: ...}` and constructs `/media/<key>`. Login timeout is 15 seconds; upload timeout is 120 seconds. Response files are created under `${XDG_CACHE_HOME:-$HOME/.cache}/image-share` and removed on handled success/failure paths; do not publish response-cache contents.

| Failure / observation | Action |
|---|---|
| Missing/unreadable file | Correct the evidence path. The helper checks file readability, not whether bytes are an image. |
| SOPS/tooling failure | Check configured repo/file paths and existing age/tool setup without printing secrets. |
| `login failed` | Check selected host/email and IaC credential source; the helper neither clears Keychain nor performs rotation. Durable service/auth repair belongs in `pve-vctcn`. |
| `already uploaded` | Reuse the saved URL. The error does not recover it. If genuinely new evidence is needed, capture it again; the helper's re-encode hint is not a guarantee against server-side deduplication. |
| Other upload HTTP error | Inspect the diagnostic privately; do not capture stderr as the URL. |
| Public URL is 404/non-image or does not render | Do not claim evidence uploaded successfully; investigate delivery/rendering. |

Transcoding, deduplication, and key format are server behavior, not promises enforced by this client. Verify returned content instead of assuming a WebP conversion, size reduction, fixed key length, or token lifetime.

## Service boundary

This skill uploads evidence; it does not administer 0721. Deployment/auth repair belongs to `pve-vctcn/apps/vctcn-app1/` (compose, admin rotation, ingress). Use `iac-projects` and `iac-issue-routing` before infrastructure changes.
