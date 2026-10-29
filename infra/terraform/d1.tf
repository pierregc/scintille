# Storm search (ADR 0027): written by the pipeline, read by the site Worker; Previews get their own.
resource "cloudflare_d1_database" "search" {
  for_each = toset(["scintille-search", "scintille-search-preview"])

  account_id            = var.account_id
  name                  = each.key
  primary_location_hint = "weur"
  read_replication = {
    mode = "disabled"
  }

  lifecycle {
    prevent_destroy = true
  }
}
