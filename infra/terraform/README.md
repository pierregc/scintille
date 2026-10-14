# Terraform (Cloudflare)

Declares the Cloudflare side of the platform ([ADR 0005](../../docs/adr/0005-hosting-and-dynamic-pages.md)).
The VPS is not here: it is ordered by hand and configured by [`infra/vps/bootstrap.sh`](../vps/README.md).

| File | Resources |
|---|---|
| `r2.tf` | Buckets `scintille-live`, `scintille-live-preview`, `scintille-lake` (ENAM, Standard, `prevent_destroy`); `r2.dev` URL off on all three; `data.scintille.app` custom domain on `scintille-live`; CORS on `scintille-live`; lifecycle on `scintille-lake` |
| `zone.tf` | Proxied `www` record, `www` → apex 301 redirect rule, Always Use HTTPS, HSTS |
| `edge.tf` | Cache rule on `data.scintille.app`, WAF rule blocking query strings and writes there, per-IP rate limit |

Ownership:

- **Wrangler** owns the Worker, its versions, its bindings and the apex record (the Worker Custom
  Domain creates it). Terraform never declares the apex.
- **By hand**: the state bucket `scintille-tfstate` and the API tokens.

Choices:

- Only `scintille-live` is public, through `data.scintille.app`. CORS allows `GET`/`HEAD` from
  `https://scintille.app` and `https://*.<workers_subdomain>.workers.dev` (our Preview URLs), never
  all of `workers.dev`.
- `scintille-live-preview` stays private, with no domain and no CORS. Previews read it server side
  through the `LIVE` binding; in the browser, Previews read the production feed on
  `data.scintille.app`, read-only ([deploy](../../docs/deploy.md#previews)).
- `scintille-lake` is private. Objects under `raw/` are deleted after 30 days; incomplete multipart
  uploads are aborted after 7 days (the rule R2 adds by default, kept because the lifecycle resource
  replaces all rules). R2 Data Catalog is enabled once by hand (the token has no catalog
  permission), see below; compaction and snapshot expiration are not managed here.
- `data.scintille.app` is cached at the edge with the `Cache-Control` the publishers set, so reads
  rarely reach R2 (billed per read). Query strings are blocked there since they would bypass the
  cache. The rate limit (Free plan: path only, 10 s) is a backstop for random paths; R2 has no
  spending cap.
- HSTS: 6 months, `includeSubDomains`, no preload, `nosniff`. Every subdomain must stay HTTPS-only.

## Inputs

Nothing secret is committed. Everything comes from the environment:

| Variable | Value | CI source |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare "terraform" token ([secrets](../../docs/secrets.md)) | secret `TF_CLOUDFLARE_API_TOKEN` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | R2 `terraform-state` S3 credentials | secrets `TF_STATE_ACCESS_KEY_ID`, `TF_STATE_SECRET_ACCESS_KEY` |
| `AWS_ENDPOINT_URL_S3` | `https://<account id>.r2.cloudflarestorage.com` | built from secret `CLOUDFLARE_ACCOUNT_ID` |
| `TF_VAR_account_id` | Cloudflare account id | secret `CLOUDFLARE_ACCOUNT_ID` |
| `TF_VAR_zone_id` | Zone id of `scintille.app` (dashboard, zone Overview, API section) | variable `CLOUDFLARE_ZONE_ID` |
| `TF_VAR_workers_subdomain` | `workers.dev` subdomain, without `.workers.dev` | variable `WORKERS_SUBDOMAIN` |

## State and locking

State lives in `scintille-tfstate` under `cloudflare/terraform.tfstate`, through the S3 backend on
the R2 endpoint. Locking uses Terraform's S3 lockfile (`use_lockfile`, a `.tflock` object written
with a conditional `If-None-Match` PUT, which R2 supports). No DynamoDB. Keep the bucket private
and versioning-free; never edit the state by hand. If a run dies holding the lock, check that
nothing else runs, then `terraform force-unlock <lock id>`.

## Day to day (from a Mac)

Store the six values of the table above once in the Keychain (prompts for each value):

```sh
for n in CLOUDFLARE_API_TOKEN AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY TF_VAR_account_id TF_VAR_zone_id TF_VAR_workers_subdomain; do
  echo "$n"; security add-generic-password -U -s scintille-terraform -a "$n" -w
done
```

Then `make tf-plan` and `make tf-apply`.

## First run (from a Mac)

From the repository root. `read -rs` keeps values out of shell history.

```sh
brew install hashicorp/tap/terraform

read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN          # "terraform" token
read -rs AWS_ACCESS_KEY_ID && export AWS_ACCESS_KEY_ID                # terraform-state key id
read -rs AWS_SECRET_ACCESS_KEY && export AWS_SECRET_ACCESS_KEY        # terraform-state secret
read -r TF_VAR_account_id && export TF_VAR_account_id
read -r TF_VAR_zone_id && export TF_VAR_zone_id
read -r TF_VAR_workers_subdomain && export TF_VAR_workers_subdomain
export AWS_ENDPOINT_URL_S3="https://$TF_VAR_account_id.r2.cloudflarestorage.com"

terraform -chdir=infra/terraform init
```

Import what already exists (created by hand in [deploy](../../docs/deploy.md#one-time-setup)), one
line per bucket that exists:

```sh
terraform -chdir=infra/terraform import 'cloudflare_r2_bucket.this["scintille-live"]' "$TF_VAR_account_id/scintille-live/default"
terraform -chdir=infra/terraform import 'cloudflare_r2_bucket.this["scintille-live-preview"]' "$TF_VAR_account_id/scintille-live-preview/default"
terraform -chdir=infra/terraform import 'cloudflare_r2_bucket.this["scintille-lake"]' "$TF_VAR_account_id/scintille-lake/default"
```

Also, if they exist:

- a `www` DNS record: `terraform -chdir=infra/terraform import cloudflare_dns_record.www "$TF_VAR_zone_id/<record id>"`
  (record id: DNS > Records > Edit, or the API);
- Redirect Rules on the zone: `terraform -chdir=infra/terraform import cloudflare_ruleset.redirects "zones/$TF_VAR_zone_id/<ruleset id>"`;
  the zone has a single ruleset for this phase, and Terraform replaces its rules with ours;
- `data.scintille.app` attached by hand to `scintille-live`: the provider documents no import for
  custom domains, so remove it (R2 > `scintille-live` > Settings > Custom Domains) just before
  `apply`. The CORS policy and zone settings need nothing: Terraform overwrites them.

Then:

```sh
terraform -chdir=infra/terraform plan    # no destroy, no "must be replaced" on a bucket
terraform -chdir=infra/terraform apply
terraform -chdir=infra/terraform plan    # "No changes."
```

Then enable R2 Data Catalog on the lake once, with your own `wrangler login` session:
`pnpm -C web exec wrangler basin catalog enable scintille-lake`.

## Checks after apply

```sh
# Test object reachable on the public domain
echo ok > /tmp/scintille-tf-check.txt
pnpm -C web exec wrangler r2 object put scintille-live/tf-check.txt --file /tmp/scintille-tf-check.txt --remote
curl -s https://data.scintille.app/tf-check.txt                      # ok

# CORS: site and Preview origins accepted, any other origin rejected
for o in https://scintille.app "https://pr-1-scintille.$TF_VAR_workers_subdomain.workers.dev" https://example.workers.dev; do
  echo "$o:"; curl -s -o /dev/null -D - -X OPTIONS https://data.scintille.app/tf-check.txt \
    -H "Origin: $o" -H 'Access-Control-Request-Method: GET' | grep -i -E '^HTTP|access-control-allow-origin'
done                                                                 # allow-origin only for the first two

pnpm -C web exec wrangler r2 object delete scintille-live/tf-check.txt --remote

# Lake and preview not public
pnpm -C web exec wrangler r2 bucket dev-url get scintille-lake          # disabled
pnpm -C web exec wrangler r2 bucket domain list scintille-lake          # none
pnpm -C web exec wrangler r2 bucket lifecycle list scintille-lake       # raw/ after 30 days
pnpm -C web exec wrangler basin catalog get scintille-lake             # active

# www: at most 2 redirects, ends on the apex; HSTS present
curl -sIL -o /dev/null -w '%{num_redirects} %{url_effective}\n' http://www.scintille.app/   # 1 or 2, https://scintille.app/
curl -sI https://scintille.app/ | grep -i strict-transport-security
```

## CI

`.github/workflows/terraform.yml`:

- On PRs touching `infra/terraform/**`: `fmt -check`, `validate`, then `plan` (in the job summary)
  only when every secret and variable of [Inputs](#inputs) is set; otherwise the plan is skipped
  with a notice.
- `apply` only through `workflow_dispatch` on `main`, in the `terraform` environment.

Setup, once:

```sh
gh secret set TF_CLOUDFLARE_API_TOKEN       # prompts for the value
gh secret set TF_STATE_ACCESS_KEY_ID
gh secret set TF_STATE_SECRET_ACCESS_KEY
gh variable set CLOUDFLARE_ZONE_ID --body "$TF_VAR_zone_id"
gh variable set WORKERS_SUBDOMAIN --body "$TF_VAR_workers_subdomain"
```

Keep these as repository secrets (the PR plan has no environment). Then GitHub > Settings >
Environments > New environment `terraform` > Required reviewers: yourself, so each apply waits for
an approval. Run it with `gh workflow run terraform --ref main`.

## Sources

- Provider v5 resources (`cloudflare_r2_bucket`, `_r2_bucket_cors`, `_r2_bucket_lifecycle`,
  `_r2_custom_domain`, `_r2_managed_domain`, `_dns_record`, `_ruleset`,
  `_zone_setting`): https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs
- R2 as a Terraform backend: https://developers.cloudflare.com/terraform/advanced-topics/remote-backend/
- S3 backend, `use_lockfile`, `AWS_ENDPOINT_URL_S3`: https://developer.hashicorp.com/terraform/language/backend/s3
- R2 conditional `PutObject`: https://developers.cloudflare.com/r2/api/s3/api/
- R2 CORS (wildcard origins need the scheme): https://developers.cloudflare.com/r2/buckets/cors/
- Single Redirects: https://developers.cloudflare.com/rules/url-forwarding/single-redirects/
