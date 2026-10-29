locals {
  buckets = toset(["scintille-live", "scintille-live-preview", "scintille-lake"])

  cors_origins = [
    "https://${var.domain}",
    "https://*.${var.workers_subdomain}.workers.dev",
  ]
}

resource "cloudflare_r2_bucket" "this" {
  for_each = local.buckets

  account_id    = var.account_id
  name          = each.key
  location      = "enam"
  storage_class = "Standard"

  lifecycle {
    prevent_destroy = true
  }
}

# No public r2.dev URL on any bucket.
resource "cloudflare_r2_managed_domain" "off" {
  for_each = cloudflare_r2_bucket.this

  account_id  = var.account_id
  bucket_name = each.value.name
  enabled     = false
}

resource "cloudflare_r2_custom_domain" "data" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.this["scintille-live"].name
  zone_id     = var.zone_id
  domain      = "data.${var.domain}"
  enabled     = true
  min_tls     = "1.2"
}

resource "cloudflare_r2_bucket_cors" "live" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.this["scintille-live"].name

  rules = [{
    id = "site-and-previews"
    allowed = {
      origins = local.cors_origins
      methods = ["GET", "HEAD"]
      headers = ["*"]
    }
    max_age_seconds = 3600
  }]
}

resource "cloudflare_r2_bucket_lifecycle" "lake" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.this["scintille-lake"].name

  rules = [
    # Sorted by id, as the API returns them.
    {
      # Replaces the default rule R2 adds to new buckets.
      id         = "abort-multipart-7-days"
      enabled    = true
      conditions = { prefix = "" }
      abort_multipart_uploads_transition = {
        condition = { type = "Age", max_age = 7 * 86400 }
      }
    },
    {
      # Empties the former GLM cache; nothing writes under raw/ any more.
      id         = "raw-1-day"
      enabled    = true
      conditions = { prefix = "raw/" }
      delete_objects_transition = {
        condition = { type = "Age", max_age = 86400 }
      }
    },
  ]
}

resource "cloudflare_r2_bucket_lifecycle" "live" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.this["scintille-live"].name

  rules = [
    # Sorted by id, as the API returns them.
    {
      id         = "abort-multipart-7-days"
      enabled    = true
      conditions = { prefix = "" }
      abort_multipart_uploads_transition = {
        condition = { type = "Age", max_age = 7 * 86400 }
      }
    },
    {
      # Cloud frames for replay; 30 days pending the retention decision (#41).
      id         = "archive-clouds-30-days"
      enabled    = true
      conditions = { prefix = "archive/clouds/" }
      delete_objects_transition = {
        condition = { type = "Age", max_age = 30 * 86400 }
      }
    },
    {
      # Travel in time (ADR 0025): the archive job deletes days after 21 days, this is the backstop.
      id         = "archive-flashes-22-days"
      enabled    = true
      conditions = { prefix = "archive/flashes/" }
      delete_objects_transition = {
        condition = { type = "Age", max_age = 22 * 86400 }
      }
    },
    {
      # Storm replays; the web reports older ones as expired (REPLAY_RETENTION_DAYS).
      id         = "storms-chunks-60-days"
      enabled    = true
      conditions = { prefix = "storms/chunks/" }
      delete_objects_transition = {
        condition = { type = "Age", max_age = 60 * 86400 }
      }
    },
  ]
}
