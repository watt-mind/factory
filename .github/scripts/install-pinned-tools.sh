#!/usr/bin/env bash
# Install checksum-pinned CI tools when the runner does not already provide them.
# Set FORCE_INSTALL=1 to populate INSTALL_PREFIX/bin even when a tool is on PATH.
set -euo pipefail

readonly BUN_VERSION='1.3.14'
readonly BUN_SHA256='951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f'
readonly GITLEAKS_VERSION='8.24.0'
readonly GITLEAKS_SHA256='cb49b7de5ee986510fe8666ca0273a6cc15eb82571f2f14832c9e8920751f3a4'
readonly UV_VERSION='0.6.5'
readonly UV_SHA256='8fc9895719a1291ecd193cb86f9282ff3649cef797d29eacc74c4f573aab1e2f'
readonly ACTIONLINT_VERSION='1.7.7'
readonly ACTIONLINT_SHA256='023070a287cd8cccd71515fedc843f1985bf96c436b7effaecce67290e7e0757'
readonly CURL_DOWNLOAD_FLAGS=(-sSL --fail --retry 5 --retry-all-errors --retry-delay 2)

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <bun|gitleaks|uv|actionlint> [...]" >&2
  exit 64
fi

temp_dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
force_install="${FORCE_INSTALL:-0}"
custom_prefix="${INSTALL_PREFIX:-}"

download() {
  local url="$1" destination="$2"
  curl "${CURL_DOWNLOAD_FLAGS[@]}" -o "$destination" "$url"
}

install_bun() {
  local prefix archive extract_dir destination
  prefix="${custom_prefix:-$HOME/.bun}"
  destination="$prefix/bin/bun"
  if [ "$force_install" != '1' ] && { [ -x "$destination" ] || { [ -z "$custom_prefix" ] && command -v bun >/dev/null 2>&1; }; }; then
    return
  fi

  archive="$temp_dir/bun-linux-x64.zip"
  extract_dir="$temp_dir/bun-linux-x64"
  rm -rf "$extract_dir"
  download "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" "$archive"
  printf '%s  %s\n' "$BUN_SHA256" "$archive" | sha256sum -c -
  unzip -q "$archive" -d "$temp_dir"
  mkdir -p "$prefix/bin"
  install -m 0755 "$extract_dir/bun" "$destination"
}

install_gitleaks() {
  local prefix archive destination
  prefix="${custom_prefix:-$HOME/.local}"
  destination="$prefix/bin/gitleaks"
  if [ "$force_install" != '1' ] && { [ -x "$destination" ] || { [ -z "$custom_prefix" ] && command -v gitleaks >/dev/null 2>&1; }; }; then
    return
  fi

  archive="$temp_dir/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
  mkdir -p "$prefix/bin"
  download "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" "$archive"
  printf '%s  %s\n' "$GITLEAKS_SHA256" "$archive" | sha256sum -c -
  tar -xzf "$archive" -C "$prefix/bin" gitleaks
  chmod +x "$destination"
}

install_uv() {
  local prefix archive extract_dir
  prefix="${custom_prefix:-$HOME/.local}"
  if [ "$force_install" != '1' ] && { [ -x "$prefix/bin/uvx" ] || { [ -z "$custom_prefix" ] && command -v uvx >/dev/null 2>&1; }; }; then
    return
  fi

  archive="$temp_dir/uv-x86_64-unknown-linux-gnu.tar.gz"
  extract_dir="$temp_dir/uv-x86_64-unknown-linux-gnu"
  rm -rf "$extract_dir"
  download "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz" "$archive"
  printf '%s  %s\n' "$UV_SHA256" "$archive" | sha256sum -c -
  tar -xzf "$archive" -C "$temp_dir"
  mkdir -p "$prefix/bin"
  install -m 0755 "$extract_dir/uv" "$extract_dir/uvx" "$prefix/bin/"
}

install_actionlint() {
  local prefix archive destination
  prefix="${custom_prefix:-$HOME/.local}"
  destination="$prefix/bin/actionlint"
  if [ "$force_install" != '1' ] && { [ -x "$destination" ] || { [ -z "$custom_prefix" ] && command -v actionlint >/dev/null 2>&1; }; }; then
    return
  fi

  archive="$temp_dir/actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz"
  mkdir -p "$prefix/bin"
  download "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz" "$archive"
  printf '%s  %s\n' "$ACTIONLINT_SHA256" "$archive" | sha256sum -c -
  tar -xzf "$archive" -C "$prefix/bin" actionlint
  chmod +x "$destination"
}

for tool in "$@"; do
  case "$tool" in
    bun) install_bun ;;
    gitleaks) install_gitleaks ;;
    uv) install_uv ;;
    actionlint) install_actionlint ;;
    *)
      echo "unknown pinned tool: $tool" >&2
      exit 64
      ;;
  esac
done
