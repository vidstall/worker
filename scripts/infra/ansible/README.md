# Ansible — dvconf VM Provisioning

Wrap-around for VM ops on `103.67.197.249`. Replaces ad-hoc `ssh ... <cmd>` patterns with idempotent, dry-runnable, version-controlled playbooks. Per [[gotchas#G-019]] multi-tenant COEXIST mode.

## Why

| Without Ansible | With Ansible |
|---|---|
| `ssh dvconf-vm "apt install foo"` — runs every time, no preview | `ansible-playbook --check` → preview diff before apply |
| Typo `rm -rf /tmp/*` runs immediately | YAML strict parsing catches errors before reaching VM |
| No audit trail | Playbooks live in Git, every change reviewable |
| Manual rollback | Many modules support `state: absent` for reverse |

## Setup (one-time)

Already done 2026-05-19:

- WSL Ubuntu 22.04 (default distro)
- Ansible 2.21 via `pip3 install --user --break-system-packages ansible-core`
- SSH key bridged: `/home/quang/.ssh/dvconf_deploy` (from Windows `~/.ssh/dvconf_deploy`)
- SSH config alias: `dvconf-vm` (deploy) + `dvconf-vm-admin` (Chaienzero)

Verify Ansible available:

```bash
wsl -d Ubuntu -- bash -c '~/.local/bin/ansible --version'
```

## Run a playbook

From this directory (`dvconf-daemons/scripts/infra/ansible/`), under WSL:

```bash
# Dry-run preview (where applicable)
wsl -d Ubuntu -- bash -c 'cd /mnt/c/Thesis/dvconf/dvconf-daemons/scripts/infra/ansible && ~/.local/bin/ansible-playbook playbooks/00-verify-state.yml --check'

# Real run
wsl -d Ubuntu -- bash -c 'cd /mnt/c/Thesis/dvconf/dvconf-daemons/scripts/infra/ansible && ~/.local/bin/ansible-playbook playbooks/00-verify-state.yml'

# Sudo-required playbook (when needed)
wsl -d Ubuntu -- bash -c 'cd /mnt/c/Thesis/dvconf/dvconf-daemons/scripts/infra/ansible && ~/.local/bin/ansible-playbook playbooks/XX-*.yml --ask-become-pass'
```

## Playbooks

| File | Purpose | Mutates? | Pre-req |
|---|---|---|---|
| `00-verify-state.yml` | Read VM identity, users, binaries, ports, containers | NO (read-only) | none |
| `10-deploy-daemons.yml` | (TBD Batch B) clone repo, install deps, systemd units | YES | 00-verify pass |
| `20-configure-coturn.yml` | (TBD Batch B) coturn config + secrets | YES (sudo) | 10 done |
| `30-start-services.yml` | (TBD Batch B) start + verify all daemons | YES | 20 done |

## Inventory

`inventory.yml` defines 2 host aliases — same VM, different user:

- **dvconf-vm**: `deploy` user, non-sudo, default for daemon-level ops
- **dvconf-vm-admin**: `Chaienzero` user, sudo+docker groups, ONLY for system-level (apt, systemd, ufw)

Sudo password: NEVER store in inventory. Pass `--ask-become-pass` interactively.

## Safety guarantees

1. **Read-only by default** — `00-verify` only queries, never writes
2. **`--check` mode** — preview ALL mutations before apply
3. **COEXIST scope** — playbooks NEVER touch `/home/deploy/`, `/home/qvanle/`, `/var/lib/docker/volumes/erp-mvp-*`, `/etc/letsencrypt/`, `/etc/nginx/`, `/etc/traefik/`
4. **Idempotent** — re-run safe (apt won't double-install, systemd won't double-enable)
5. **Git tracked** — every diff reviewable by Văn / team

## See also

- `../bootstrap-vm.sh` — original imperative script (kept for reference; future deploy → Ansible)
- `docs/00-meta/batch-a-plan.md` § Stage 4 — bootstrap context
- `docs/00-meta/gotchas.md` § G-019 multi-tenant coexist
