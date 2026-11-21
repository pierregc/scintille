# VPS

OVH VPS-2 (4 vCores, 8 GB, 75 GB NVMe), Beauharnois, Debian 13. Ordered by hand; configured by `bootstrap.sh`, safe to re-run:

```sh
ssh debian@<host> 'sudo bash -s' < infra/vps/bootstrap.sh
```

- `debian`: admin with sudo, key only. `deploy`: no sudo, member of `docker`, key only.
- SSH: no root login, no passwords. Firewall: only SSH inbound. fail2ban on SSH. Unattended security upgrades, with a reboot at 04:20 UTC when one is required ([reboots](../../docs/operations.md#reboots)). Timezone UTC.
- Docker publishes ports around ufw: never publish a container port publicly; services reach the outside, nothing comes in.
- Lost key: OVH control panel > KVM console or rescue mode to add a new public key.
