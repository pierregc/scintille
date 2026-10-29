output "data_domain" {
  value = cloudflare_r2_custom_domain.data.domain
}

output "cors_origins" {
  value = local.cors_origins
}

output "d1_databases" {
  value = { for name, db in cloudflare_d1_database.search : name => db.uuid }
}
