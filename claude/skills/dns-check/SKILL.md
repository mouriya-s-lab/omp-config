---
name: dns-check
description: Check if a new VM/CT is discoverable via ARP scan and registered in the homelab CoreDNS on CT 312 `dns`. Use when a new VM or CT is created, or when DNS resolution for a LAN host fails.
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, mcp__ssh-manager__ssh_execute
---

# DNS host check & registration

Check how a guest's name is answered by CT 312 (`dns`, `192.168.1.22`, `dns.hb.lan`): direct PVE-plugin discovery or generated zone data. Correlate guest identity, reachability, producer state and DNS responses before selecting scanner, IaC identity, or connectivity repair. A guest need not appear in `lan.hosts` to have a valid plugin-served A record.

Use `iac-projects` / `iac-issue-routing` before any fix that changes infrastructure. Read the current `homelab-tf` entrypoint and DNS role docs to confirm the topology below; inspection does not authorize scanner runs, playbook apply, or bridge changes.

## Arguments

- First skill argument: guest IP (required).
- Second skill argument: desired hostname (optional; the scanner fallback is `host-<last-octet>`).

Commands below use `<IP>` and `<hostname>` placeholders, not shell `$0`/`$1`; substitute the verified values before running.

## DNS layering (CT 312, hostname `dns`)

Read the DNS repo entrypoint for orientation, then use current templates and parent render inputs for the contracts below:

- **unbound** — external recursive resolver on `192.168.1.22:53` + `127.0.0.1:53`. Forwards `hb.lan → 127.0.0.1:5300` to CoreDNS; recurses everything else via DoT.
- **coredns** — authoritative for `*.hb.lan` on `127.0.0.1:5300`. The bundled `proxmox` plugin can answer PVE guest names directly; on fallthrough, the `file` plugin serves generated forward/reverse zones under `/etc/coredns/zones/`, reloading every 15 seconds.
- **kea** — DHCPv4; writes leases into `/etc/coredns/sources/dhcp.hosts`.
- **dns-info** — HTTP info page on `:80`.

State authority split:

| File on CT 312 | Owner | How it's updated |
|---|---|---|
| `/etc/coredns/Corefile`, `/etc/coredns/sources/static.hosts`, scanner service environment | IaC | Parent `network/identities.yaml` + managed `vms/*.yaml` feed `_shared/scripts/render-dns-identity.py`; `make ct-provision-dns` injects the resulting A/alias/exclusion inputs into the DNS role |
| `/etc/coredns/sources/scan.hosts` | Runtime producer | `update-lan-hosts.timer` (ARP + mDNS + NetBIOS) |
| `/etc/coredns/sources/dhcp.hosts` | Runtime producer | `kea-leases-to-hosts.timer` from Kea's lease DB |
| `/etc/coredns/lan.hosts`, `/etc/coredns/zones/*.zone` | Runtime merger | `coredns-merge-hosts.path` triggers source merging and forward A / reverse PTR zone rendering; `lan.hosts` is an intermediate used by the renderer and info page, not the served zone |
| `/etc/unbound/*` | IaC | `roles/unbound/defaults/main.yml` |
| `/etc/kea/kea-dhcp4.conf` | IaC | `roles/kea/defaults/main.yml` |

Never hand-edit any of these files on the CT — the runtime producers or the next `make ct-provision-dns` will overwrite them without warning.

Implementation authority: `dns/roles/coredns/templates/{Corefile.j2,coredns-merge-hosts.sh.j2,update-lan-hosts.service.j2}`, parent `Makefile` and `_shared/scripts/render-dns-identity.py`. PVE-plugin answers bypass these source files; the reverse file zone contains only addresses rendered from `lan.hosts`. Unknown zone names receive authoritative NXDOMAIN with SOA, not a hosts-plugin SERVFAIL.

## Access path

CT 312 (`dns`) is **not** registered in `~/.ssh-manager/.env` as its own server. To run commands on it, go via the PVE host:

```bash
# Preferred — through ssh-manager to the PVE host, then pct exec
mcp__ssh-manager__ssh_execute server=pve command="pct exec 312 -- <cmd>"
```

Use the PVE/pct path; `ssh-mcp-sync` deliberately excludes CTs. Direct CT SSH is not a prerequisite for this workflow and should not trigger requests to install keys or sshd.

## Step 1: gather current state

Run these in parallel:

1. **ARP scan check** (on CT 312): `arp-scan --interface=eth0 <IP>` — does the host respond to ARP?
2. **Record provenance**: inspect `sources/*.hosts`, merged `lan.hosts`, and generated forward/reverse zone files, matching exact address/name fields. If absent, inspect the current `proxmox` plugin configuration and guest-discovery logs: plugin A answers do not pass through `lan.hosts`. Do not read its token file.
3. **Ping** (on CT 312): `ping -c 2 -W 1 <IP>` — basic reachability
4. **DNS resolution test** (from anywhere on the LAN):
   - Forward: `dig +short <hostname>.hb.lan @192.168.1.22`
   - Reverse: `dig +short -x <IP> @192.168.1.22`. A plugin-only A record does not by itself imply a PTR exists; compare against the required reverse-record contract.
5. **PVE config** (via PVE): locate the IP/hostname in `/etc/pve/lxc/*.conf` and `/etc/pve/qemu-server/*.conf` to confirm guest identity and MAC. Use the available file/search tool; do not infer guest identity from an ARP label alone.

## Step 2: report findings

| Check            | Result |
|------------------|--------|
| PVE config       | found / not found (VMID, type, MAC) |
| Ping             | reachable / unreachable |
| ARP scan         | found (MAC) / not found |
| Record provenance | static / dhcp / scan zone entry / direct PVE plugin / unknown |
| DNS forward | expected name and IP / unexpected answer / NXDOMAIN / SERVFAIL |
| DNS reverse | expected PTR / absent as expected for plugin-only record / missing required PTR / error |

## Step 3: diagnose & fix

### Case A — Expected DNS answer from its intended authority
Report success for the requested contract even if an A record is served directly by the PVE plugin and absent from `lan.hosts`. Report PTR separately; do not call a plugin-only A answer broken because it lacks a generated reverse record.

### Case B — Non-PVE device expected from scanner but absent
First rule out an intentional `IP_SKIP` exclusion or a PVE-plugin-owned identity. The scanner covers non-PVE LAN discovery; adding another source for an already authoritative name is not a repair.

- Inspect the scanner timer/service and logs. The documented schedule is every five minutes; a stopped/failed producer will not heal merely by waiting.
- **Wait for a healthy timer**: inspect the next tick and check for the discovered name or `host-<last-octet>.hb.lan`.
- **Authorized trigger** (on CT 312): `systemctl start update-lan-hosts.service`. The unit executes `/usr/local/sbin/update-lan-hosts.sh` with the IaC-rendered `IP_SKIP` environment and a 120-second timeout. Do not invoke the script directly and lose those exclusions. This changes runtime state.
- Observe scanner completion, `scan.hosts`, merger output and zone reload. `coredns-merge-hosts.path` renders both zones; the `file` plugin reloads them without restarting CoreDNS.
- Then re-check with `dig +short <hostname>.hb.lan @192.168.1.22`.

### Case C — Custom hostname wanted (won't be auto-discovered)
Static A/CNAME records live in IaC, not on the CT. Do **not** create files under `/etc/coredns/sources/` by hand — they will not survive the next playbook run.

Use the parent identity authority in the authorized `homelab-tf` implementation:

- Managed CT / infrastructure A names and addresses: `network/identities.yaml` under `ct` or `infrastructure_hosts`.
- Managed VM aliases: `coredns_aliases` in that VM's workspace `vms/<vmid>.yaml`; the target is its declared `hostname`.
- Alias for an explicitly unmanaged target: `network/identities.yaml` `external_aliases`, including its required reason.
- Extra infrastructure scanner exclusions: the owning `infrastructure_hosts` record's `scanner_exclude_ipv4`; the renderer also derives exclusions from CT/infrastructure static addresses.

The renderer produces `coredns_static_a`, `coredns_static_cnames`, `coredns_scanner_ip_skip` and `homelab_dns_ipv4`. These are mandatory caller inputs, not values to add back into role defaults. CNAME-style aliases are materialized as Corefile query/answer rewrites.

Use `iac-projects` and `iac-issue-routing`; an execution-ready deployment issue uses `iac-auto-deploy-issue`. The approved parent entrypoint is `cd ~/Ext/code/homelab-tf && make ct-provision-dns`: `Makefile` discovers managed VM YAMLs and injects renderer output through extra-vars. This is a live apply to CT 312, not a local sandbox; follow the current repo's full apply/evidence boundary.

### Case D — ARP missing or guest connectivity failing
Separate a scanner blind spot from actual guest failure. Check:

1. **Not started** — `qm status <vmid>` / `pct status <vmid>` on PVE.
2. **Network mis-configured** — check the guest has a NIC on `vmbr0` (or the correct SR-IOV VF) with a valid IP/DHCP lease.
3. **SR-IOV FDB gap** — VMs using SR-IOV VF passthrough may not appear in the PF FDB, so CT 312's veth can't reach them:
   ```bash
   bridge fdb show dev enp2s0f0 | grep <VM-MAC>
   ```
   If missing, inspect the current `/etc/network/if-up.d/sriov-fdb` ownership and interface identity. The documented emergency command is `bridge fdb add <VM-MAC> dev enp2s0f0`, but it mutates the PVE host and requires an explicitly authorized recovery scope; route durable repair through IaC. The `coredns-proxmox` plugin can resolve SR-IOV guests from its state dump even when the ARP scanner cannot see them, so a missing ARP response is not proof of failed DNS.
4. **Guest firewall** blocking ICMP/ARP.

Fix connectivity, then go back to Step 1.

## Verification

After the authorized repair, repeat the requested forward/reverse `dig` from the actual LAN client path against `192.168.1.22`; compare each answer with its intended source and record contract. For zone-backed records, observe source, merge, generated zone and reload; for direct PVE answers, inspect guest identity/plugin discovery without requiring a `lan.hosts` entry. A required PTR must be verified independently. A successful apply/scanner exit alone does not prove resolution; `unbound-control` is not the LAN-record mutation path.
