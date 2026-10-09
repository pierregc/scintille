# The apex record belongs to the Worker Custom Domain (Wrangler), never to Terraform.

# Originless: www only exists to be redirected.
resource "cloudflare_dns_record" "www" {
  zone_id = var.zone_id
  name    = "www.${var.domain}"
  type    = "AAAA"
  content = "100::"
  proxied = true
  ttl     = 1
  comment = "Redirected to the apex (Terraform)"
}

resource "cloudflare_ruleset" "redirects" {
  zone_id = var.zone_id
  name    = "Redirects"
  kind    = "zone"
  phase   = "http_request_dynamic_redirect"

  rules = [{
    ref         = "www_to_apex"
    description = "www to apex, 301"
    expression  = "(http.host eq \"www.${var.domain}\")"
    action      = "redirect"
    action_parameters = {
      from_value = {
        status_code           = 301
        preserve_query_string = true
        target_url = {
          expression = "concat(\"https://${var.domain}\", http.request.uri.path)"
        }
      }
    }
  }]
}

resource "cloudflare_zone_setting" "always_use_https" {
  zone_id    = var.zone_id
  setting_id = "always_use_https"
  value      = "on"
}

resource "cloudflare_zone_setting" "hsts" {
  zone_id    = var.zone_id
  setting_id = "security_header"
  value = {
    strict_transport_security = {
      enabled            = true
      max_age            = 15552000
      include_subdomains = true
      preload            = false
      nosniff            = true
    }
  }
}
