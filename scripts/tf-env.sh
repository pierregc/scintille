# Sourced by `make tf-plan` and `make tf-apply`: Terraform credentials from a file outside the repo.
file=${TF_ENV_FILE:-$HOME/.config/scintille/terraform.env}
[ -r "$file" ] || { echo "Missing $file, see infra/terraform/README.md" >&2; return 1; }
unset AWS_PROFILE AWS_DEFAULT_PROFILE
set -a
source "$file"
set +a
export AWS_ENDPOINT_URL_S3="https://$TF_VAR_account_id.r2.cloudflarestorage.com"
