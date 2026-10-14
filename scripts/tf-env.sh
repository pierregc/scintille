# Sourced by `make tf-plan` and `make tf-apply`: Terraform credentials from the macOS Keychain.
# Store each once: security add-generic-password -U -s scintille-terraform -a <NAME> -w
unset AWS_PROFILE AWS_DEFAULT_PROFILE
for name in CLOUDFLARE_API_TOKEN AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY \
	TF_VAR_account_id TF_VAR_zone_id TF_VAR_workers_subdomain; do
	value=$(security find-generic-password -s scintille-terraform -a "$name" -w 2>/dev/null) \
		|| { echo "$name is not in the Keychain (service scintille-terraform)" >&2; return 1; }
	export "$name=$value"
done
export AWS_ENDPOINT_URL_S3="https://$TF_VAR_account_id.r2.cloudflarestorage.com"
