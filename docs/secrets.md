# Secrets

Names and scopes only, never values. Values live in the maintainer's password manager and, where a
workflow needs them, in GitHub Actions encrypted secrets. Nothing secret is committed.

| Secret | Kind and scope | Used by | Stored in |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare account API token "deploy": Workers Scripts Edit, Workers R2 Storage Read | Site deployment with Wrangler (#16) | GitHub Actions secret, password manager |
| `CLOUDFLARE_ACCOUNT_ID` | Account identifier (not secret, kept next to the token) | Wrangler, Terraform | GitHub Actions secret |
| Cloudflare purge token | Cloudflare account API token "purge": Cache Purge on the `scintille.app` zone only | Pipeline on the VPS, batched tag purges (#74) | Password manager, then the VPS environment file (#19) |
| Cloudflare Terraform token | Cloudflare account API token "terraform": zone `scintille.app` DNS Edit, Zone Settings Edit, Dynamic URL Redirects Edit; account Workers R2 Storage Edit | Terraform (#18) as `CLOUDFLARE_API_TOKEN`, run by hand then by the `terraform` workflow | Password manager, GitHub Actions secret `TF_CLOUDFLARE_API_TOKEN` |
| R2 `terraform-state` credentials | R2 S3 access key, Object Read & Write on bucket `scintille-tfstate` only | Terraform S3 backend (#18) as `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Password manager, GitHub Actions secrets `TF_STATE_ACCESS_KEY_ID`, `TF_STATE_SECRET_ACCESS_KEY` |
| R2 VPS credentials | R2 S3 access key, Object Read & Write on `scintille-live` and `scintille-lake` only | `ingest-live`, `lake-writer`, Dagster on the VPS | Created once Terraform has created the buckets |
| EUMETSAT Data Store credentials | API key pair of the maintainer's EUMETSAT account (api.eumetsat.int), read access to the Data Store | `eumdac` in `ingest-live` for MTG LI (#32) | Password manager, `/srv/scintille/.env` as `SCINTILLE_EUMETSAT_CONSUMER_KEY` / `SCINTILLE_EUMETSAT_CONSUMER_SECRET` |
| VPS SSH access | Maintainer's ed25519 key for user `debian`, then a dedicated `deploy` user | Administration and deployment (#19) | Maintainer's machine |

The VPS is an OVH VPS-2 in Beauharnois (Canada), managed by hand and by scripts in the repository;
no OVH API token is needed.

## Rotation

1. Create the new token or key with the same scope (Cloudflare dashboard, R2 > Manage R2 API Tokens, or api.eumetsat.int for EUMETSAT).
2. Update every place listed in "Stored in" (GitHub: Settings > Secrets and variables > Actions; VPS: environment file, then restart the services).
3. Check the consumer: a deployment for `CLOUDFLARE_API_TOKEN`, `terraform plan` for Terraform tokens, one ingestion cycle for the VPS credentials.
4. Revoke the old token.

Rotate at least once a year, and immediately if a value may have leaked.
