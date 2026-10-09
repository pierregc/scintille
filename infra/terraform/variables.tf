variable "account_id" {
  description = "Cloudflare account id."
  type        = string
}

variable "zone_id" {
  description = "Zone id of scintille.app."
  type        = string
}

variable "workers_subdomain" {
  description = "Account workers.dev subdomain; Preview URLs are https://<name>.<subdomain>.workers.dev."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?$", var.workers_subdomain))
    error_message = "Must be a single DNS label, never a wildcard."
  }
}

variable "domain" {
  description = "Apex domain of the site."
  type        = string
  default     = "scintille.app"
}
