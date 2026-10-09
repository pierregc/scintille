# Deployment

The site (`web/`) is one Cloudflare Worker named `scintille`, deployed with Wrangler from GitHub
Actions ([ADR 0005](adr/0005-hosting-and-dynamic-pages.md)). Every page is prerendered today, so the
Worker only serves static assets; the R2 binding is ready for the on-demand storm and region pages
(#88, #90).

## Configuration

`web/wrangler.jsonc`, read by `@astrojs/cloudflare` at build time:

| Setting | Value | Why |
|---|---|---|
| `assets.run_worker_first` | `false` | Static files are served before the Worker runs, free and unmetered. |
| `cache.enabled` | `false` | With Workers Cache on, every asset request is billed as a Worker request. Astro's `cacheCloudflare()` is not used either. |
| `routes` | `scintille.app`, `custom_domain: true` | Wrangler attaches the apex as a Worker Custom Domain and Cloudflare issues its certificate. |
| `workers_dev` / `preview_urls` | `false` / `true` | Production answers only on `scintille.app`; Previews still get `workers.dev` URLs. |
| `r2_buckets` | binding `LIVE` → `scintille-live` | Production data. |
| `previews.r2_buckets` | binding `LIVE` → `scintille-live-preview` | Previews never see production data. |

Server code reads the bucket with `import { env } from 'cloudflare:workers'` and `env.LIVE`.

The build (`pnpm -C web build`) writes the assets to `web/dist/client/` and a generated Wrangler
config there; `wrangler deploy` and `wrangler preview` pick it up through
`web/.wrangler/deploy/config.json`. Always build before running them.

## Production

On every push to `main` that touches `web/`, the `web` workflow runs the checks (`check`, `lint`,
`test`, `build`, `test:seo`, `wrangler deploy --dry-run`), then the `deploy` job runs
`wrangler deploy`. Deploys never run in parallel. To redeploy without a change, run the workflow by
hand: Actions > web > Run workflow on `main` (`gh workflow run web.yml --ref main`).

## Previews

Each pull request that touches `web/` gets a Preview named `pr-<number>`:

- URL: `https://pr-<number>-scintille.<account-subdomain>.workers.dev`, posted as a comment on the PR
  and updated on each push.
- Bound to `scintille-live-preview` through the `previews` block. Wrangler is run with
  `--ignore-base-config`, so nothing set in the dashboard can add a binding.
- Sends `X-Robots-Tag: noindex`: Cloudflare adds it on `workers.dev` Preview URLs, and the workflow
  also appends it to `_headers` for the Preview build only. The job fails if the header is missing.
- Deleted when the PR is closed or merged.

A PR cannot write to `scintille-live`: the only binding a Preview gets is the preview bucket,
`web/scripts/deploy-config.test.ts` fails if `previews` ever names the production bucket, and the
deploy token has no R2 write access. Pages in a Preview still read the public feed and textures on
`data.scintille.app` from the browser, read-only. A PR that edits both the config and its test could
still bind production: review any change to `web/wrangler.jsonc` and `.github/workflows/web.yml`.

## Secrets and variables

| Name | Kind | Use |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Actions secret | Account-owned token: Workers Scripts Edit, Workers R2 Storage Read ([secrets](secrets.md)) |
| `CLOUDFLARE_ACCOUNT_ID` | Actions secret | Passed to every Wrangler call, so Wrangler never calls user-only endpoints |
| `DEPLOY_ENABLED` | Actions variable | `true` turns on the `deploy`, `preview` and `preview-cleanup` jobs |

`DEPLOY_ENABLED` stays unset until the buckets exist: a deploy with an R2 binding to a missing bucket
fails. Deploys pass `--x-auto-create=false` so Wrangler never tries to create a bucket from CI.

## One-time setup

1. **Create the two buckets** in the dashboard (or let Terraform create them, [infra/terraform](../infra/terraform/README.md)):
   Storage & databases > R2 > Overview > Create bucket.
   - Name `scintille-live`, Location: Automatic, with the location hint "Eastern North America
     (ENAM)", default storage class Standard. Create.
   - Same for `scintille-live-preview`.
   - Leave both private: no public development URL, no custom domain yet.
2. **Check the `workers.dev` subdomain** exists: Workers & Pages > Account details > Subdomain.
   Preview URLs use it.
3. **Check the apex DNS records** of `scintille.app` (DNS > Records). The Custom Domain creates its own
   record for the apex; in CI Wrangler overrides any existing `A`, `AAAA` or `CNAME` on the apex without
   asking. Delete them yourself first if you want to see what goes away.
4. **Seed the preview bucket** from the repository fixtures (uses your own Wrangler login, not the
   CI token):
   ```sh
   pnpm -C web exec wrangler login
   pnpm -C web r2:upload fixtures --preview
   ```
5. **Upload the Earth textures** to `scintille-live` (see [Textures](#textures)).
6. **Turn deploys on**: `gh variable set DEPLOY_ENABLED --body true`.
7. Re-run the `web` workflow of an open PR to check its Preview, then merge to deploy production.

## Textures

Globe textures are generated locally and never committed ([assets](assets.md)). Production loads
them from `https://data.scintille.app/textures/v2/<tier>/<name>.webp`, stored in `scintille-live`
under `textures/v2/` with `Cache-Control: public, max-age=31536000, immutable`:

```sh
brew install basis_universal
pnpm -C web textures
pnpm -C web r2:upload textures
```

The files are immutable: after regenerating them with different content, bump the version in
`web/scripts/r2-upload.mjs` and in the default of `texturesRoot` (`web/src/globe/earth.ts`).

`data.scintille.app` (public custom domain on `scintille-live`) and its CORS policy are declared in
[infra/terraform](../infra/terraform/README.md). Until they are applied, the production globe has
neither textures nor live data.

## Local development

`pnpm -C web dev` runs the site on `workerd` through the adapter, with a local `LIVE` bucket kept in
`web/.wrangler/state/` (git-ignored). Seed it from the fixtures:

```sh
pnpm -C web r2:upload fixtures --local
```

The globe itself still fetches the live feed from the browser, so it keeps using the fixture server
(`python3 fixtures/serve.py`) in place of `data.scintille.app`; the local bucket is for server code.

## Rollback

- **Fast**: Workers & Pages > `scintille` > Deployments, pick the previous version, Rollback. Or
  locally: `pnpm -C web exec wrangler versions list`, then
  `pnpm -C web exec wrangler rollback <version-id> --message "<reason>"`.
- **Durable**: revert the commit on `main` through a PR; the merge redeploys.

A rollback restores code, assets and bindings of that version. It never touches R2 data.

## After the first deploy

```sh
curl https://scintille.app/robots.txt                  # our robots.txt
curl -A GPTBot -sI https://scintille.app/ | head -n 1  # HTTP/2 200
curl -sI https://pr-<number>-scintille.<account-subdomain>.workers.dev/ | grep -i x-robots-tag  # noindex
```

## Sources

- https://developers.cloudflare.com/workers/previews/ and its Configuration, Resources and Custom
  domains pages: the `previews` block (top-level bindings not inherited), R2 isolation by binding
  another bucket, `X-Robots-Tag: noindex` on `workers.dev` Preview URLs. `wrangler preview` needs
  Wrangler 4.135+ and is in open beta.
- https://developers.cloudflare.com/workers/wrangler/commands/workers/: `wrangler preview`, `preview delete`.
- https://developers.cloudflare.com/workers/configuration/routing/custom-domains/: Custom Domains.
- https://docs.astro.build/en/guides/integrations-guide/cloudflare/: adapter, dev on `workerd`.
