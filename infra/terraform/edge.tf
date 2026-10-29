locals {
  data_host = "data.${var.domain}"
}

# Serve data.scintille.app from the edge, honouring the Cache-Control the publishers set,
# so most reads never reach R2.
resource "cloudflare_ruleset" "cache" {
  zone_id = var.zone_id
  name    = "Cache"
  kind    = "zone"
  phase   = "http_request_cache_settings"

  rules = [{
    ref         = "cache_data"
    description = "Cache data files per their Cache-Control"
    expression  = "(http.host eq \"${local.data_host}\")"
    action      = "set_cache_settings"
    action_parameters = {
      cache       = true
      edge_ttl    = { mode = "respect_origin" }
      browser_ttl = { mode = "respect_origin" }
    }
  }]
}

resource "cloudflare_ruleset" "waf" {
  zone_id = var.zone_id
  name    = "Custom rules"
  kind    = "zone"
  phase   = "http_request_firewall_custom"

  rules = [{
    # Query strings would bypass the cache and bill an R2 read each time.
    ref         = "data_read_only"
    description = "Data: GET, HEAD and OPTIONS without query string only"
    expression  = "(http.host eq \"${local.data_host}\" and (http.request.uri.query ne \"\" or not http.request.method in {\"GET\" \"HEAD\" \"OPTIONS\"}))"
    action      = "block"
  }]
}

# Free plan: one rule, path field only, per IP and colo, 10 s windows.
# A first visit loads about 160 files (assets, textures, 120 live chunks).
resource "cloudflare_ruleset" "rate_limit" {
  zone_id = var.zone_id
  name    = "Rate limiting"
  kind    = "zone"
  phase   = "http_ratelimit"

  rules = [{
    ref         = "per_ip"
    description = "300 requests per 10 s per IP"
    expression  = "(http.request.uri.path ne \"\")"
    action      = "block"
    ratelimit = {
      characteristics     = ["cf.colo.id", "ip.src"]
      period              = 10
      requests_per_period = 300
      mitigation_timeout  = 10
    }
  }]
}

# One upper tier next to the bucket: a short manifest max-age does not multiply R2 reads (ADR 0026).
resource "cloudflare_argo_tiered_caching" "tiered" {
  zone_id = var.zone_id
  value   = "on"
}

resource "cloudflare_tiered_cache" "smart" {
  zone_id = var.zone_id
  value   = "on"
}
