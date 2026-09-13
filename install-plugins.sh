#!/usr/bin/env bash
set -euo pipefail

command -v omp >/dev/null 2>&1 || {
  printf '%s\n' 'omp is required on PATH' >&2
  exit 1
}

plugins=(
  'https://github.com/giuseppe-trisciuoglio/pi-rules'
  'pi-bro'
  'pi-commandcode-provider'
  'pi-package-search'
  'pi-patty-bg-tasks'
  'pi-pretty-codeblocks'
  'pi-schedule'
  'https://github.com/Mouriya-Emma/omp-thinking-translator'
)

for plugin in "${plugins[@]}"; do
  omp install "$plugin"
done
