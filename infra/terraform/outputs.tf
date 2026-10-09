output "data_domain" {
  value = cloudflare_r2_custom_domain.data.domain
}

output "cors_origins" {
  value = local.cors_origins
}

output "lake_catalog_name" {
  value = cloudflare_r2_data_catalog.lake.name
}
