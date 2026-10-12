# Local checks and deploys

Without GitHub Actions, run the same checks and deploys from a Mac with `make` (list: `make`).

| Command | Same as | Needs |
|---|---|---|
| `make check` | secrets, data, web, rollback | |
| `make data` | `data` job | uv |
| `make web` | `web` job | pnpm |
| `make secrets` | `secrets` workflow | `brew install gitleaks` |
| `make lake` | `lake` job | Docker |
| `make smoke` | `images` smoke job | Docker, several GB |
| `make rollback` | `images` rollback job | Docker |
| `make render` | `render` workflow | Playwright (installed by the script) |

`make data` compares the contract with `origin/main`; use `BASE=<ref>` to change it.

If Docker hangs while pulling, a Keychain prompt is waiting for you. Or point `DOCKER_CONFIG` at a
directory containing `{}` as `config.json`.

## Deploy

From a clean `main` equal to `origin/main`, in this order (or `make deploy`):

```sh
pnpm -C web exec wrangler login   # once
make deploy-web                   # scintille.app
docker login ghcr.io -u pierregc  # once, token with write:packages
make deploy-images                # linux/amd64 images, tagged with the commit and main
make deploy-vps                   # uploads the compose file, runs deploy.sh, rolls back on failure
```

`deploy-vps` uses `~/.ssh/scintille_deploy` and `deploy@VPS_HOST` (override with `VPS_KEY`,
`VPS_USER`, `VPS_HOST`). The first VPS deploy also needs the `.env` and the GHCR login on the VPS
([deploy](deploy.md)).
