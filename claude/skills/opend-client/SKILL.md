---
name: opend-client
description: Connect to moomoo OpenD on VM 130 for quotes/klines/basicinfo; handle RSA InitConnect and check sha error using the persisted PEM. Includes recorded market boundaries (TW unsupported). Client-side only; deployment, SMS, passwords, console, and restart policy belong to homelab-trading's opend skill.
---

# opend-client

Client connection recipe and recorded deployment observations. Read `homelab-trading` for ownership; verify endpoint, SDK/server version, and current capability before treating these observations as live state. This guide does not authorize trades or server changes.

## Endpoint

- Host: `trading-agent.mouriya.lan` (NetBird mesh); verify the client has mesh access.
- LAN fallback: `192.168.1.225` (same VM, plain LAN).
- Port: `11111` (moomoo OpenAPI binary protocol).
- `22222` (OpenD telnet console) is loopback-only — not reachable
  off-host. For console ops, ssh into `trading-agent` first.

Reachability probe:

```bash
bash -c '</dev/tcp/trading-agent.mouriya.lan/11111 && echo OPEN || echo CLOSED'
```

## RSA handshake is mandatory — even for quote

The recorded deployment enables `encrypt_rsa_prikey` at **InitConnect** (proto_id 1001), including quote connections. Enable `proto_encrypt` and point the SDK at the PEM on every client. Do not retry `check sha error` by disabling encryption; check that the client uses the canonical key and matching SDK/server protocol configuration.

## RSA private key — persisted location

Canonical key source: `homelab-trading::secrets.yml::FUTU_RSA_PEM`. The recorded key is 1024-bit RSA; the intended local credential location is:

```
~/.config/futu/futu.pem    (mode 0400)
```

Reuse an existing usable key; mere file existence is not success. An empty or unparseable local PEM is a provisioning failure, while a parseable but server-mismatched key is a separate handshake failure. When provisioning/recovery from the canonical SOPS source is required, stage and validate the replacement before touching the destination:

```bash
(
  set -euo pipefail
  umask 077
  key="$HOME/.config/futu/futu.pem"
  mkdir -p "$HOME/.config/futu"
  tmp="$(mktemp "$HOME/.config/futu/.futu.pem.XXXXXXXX")"
  trap 'rm -f "$tmp"' EXIT
  trap 'exit 1' HUP INT TERM
  cd ~/Ext/code/homelab-trading
  sops -d secrets.yml | yq -er '.FUTU_RSA_PEM' > "$tmp"
  if [[ ! -s "$tmp" ]] || ! openssl pkey -in "$tmp" -passin pass: -check -noout >/dev/null 2>&1; then
    printf '%s\n' 'OpenD key provisioning failed: extracted PEM is empty or invalid' >&2
    exit 1
  fi
  chmod 400 "$tmp"
  mv -f "$tmp" "$key"
)
```

This requires `sops`, Mike Farah `yq`, and `openssl`. Failed extraction or validation removes the staging file and leaves any existing canonical file unchanged; no partial result becomes `futu.pem`. Validation suppresses key output and uses an empty passphrase explicitly so an unexpected encrypted PEM fails rather than prompting. A successful local parse proves usable private-key syntax/consistency, not server key agreement; verify that through the encrypted quote connection.

Uses the homelab-tf age identity (Bitwarden note `homelab-tf-sops-age-key`); the macOS SOPS identity path is `~/Library/Application Support/sops/age/keys.txt`. Check the existing local setup rather than assuming it is provisioned. Missing decryption access is a credential-integration gap; do not request a pasted PEM.

The PEM in `secrets.yml` is the canonical copy. Any client host that
needs to talk to opend gets it from there; do not copy the PEM into
client repos.

## Python client — minimal working snippet

```python
from futu import OpenQuoteContext, SysConfig, RET_OK

SysConfig.enable_proto_encrypt(True)
SysConfig.set_init_rsa_file('/Users/mouriya/.config/futu/futu.pem')

ctx = OpenQuoteContext(host='trading-agent.mouriya.lan', port=11111)
try:
    ret, df = ctx.get_market_snapshot(['HK.00700', 'US.AAPL'])
    if ret != RET_OK:
        raise RuntimeError(df)
    print(df)
finally:
    ctx.close()
```

For trade (`OpenSecTradeContext`), additionally pass
`is_encrypt=True` and the correct `security_firm` (moomoo JP →
`SecurityFirm.MOOMOOJP`). RSA encryption is the same key.

SDK setup, only when the current client project has no suitable environment:

```bash
# Run in the client project; reuse its existing environment when available.
python3 -m venv .venv
source .venv/bin/activate
pip install futu-api
```

The recorded successful pairing is `futu-api 10.06.6608` with `server_ver: 1006`; this is not a claim about the installed version today. Success requires `RET_OK` and actual requested quote data, not merely TCP `OPEN`. Entitlement/account/session errors are distinct from encryption or unsupported-market failures.

## Recorded server market boundary

The existing deployment record derives this accepted-code list from `get_stock_basicinfo` validation. Preserve it as the baseline for that server version; on a changed server, verify the response before asserting an expanded list:

| Code | Market |
|---|---|
| HK | Hong Kong Stock Exchange |
| US | NYSE / Nasdaq / AMEX |
| SH | Shanghai Stock Exchange |
| SZ | Shenzhen Stock Exchange |
| HK_FUTURE | HKEX futures |
| SG | Singapore Exchange |
| JP | Japan (Tokyo) |
| AU | Australian Securities Exchange |
| MY | Bursa Malaysia |
| CA | Toronto (TSX) |
| FX | Forex |
| CC | Crypto (moomoo's crypto desk) |

`get_global_state` additionally reports state for the futures markets
(`market_hkfuture`, `market_usfuture`, `market_sgfuture`,
`market_jpfuture`) but those are queried under the relevant code, not
as a separate `Market.*` enum.

TW, KR, EU venues, and IN are absent from this recorded protocol set; TW is not supported by that deployment. Do not treat unsupported-market validation as an entitlement problem or hunt for a flag to enable it. Accepted market codes also do not imply this account has quote entitlements for every instrument.

## What this skill does NOT cover

- Server-side deployment, SMS first-run, MD5 password derivation,
  device whitelist persistence, `restart: "no"` rationale, telnet
  console ops on `:22222`, retry-via-`km` mechanics → all in
  `mouriya-s-lab/homelab-trading::.claude/skills/opend/`.
- VM 130 lifecycle, mesh enrollment, DNS, registry → IaC repos via
  `iac-projects`.
- Operating the stack remotely (deploy/restart/destroy/logs) →
  `km-stack` / `km-container` with `-p trading`.
