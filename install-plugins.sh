#!/usr/bin/env bash
set -euo pipefail

command -v omp >/dev/null 2>&1 || {
  printf '%s\n' 'omp is required on PATH' >&2
  exit 1
}

plugins=(
  'pi-commandcode-provider'
  'pi-package-search'
  'pi-unified-exec'
  'pi-pretty-codeblocks'
  'pi-schedule'
  'https://github.com/Mouriya-Emma/omp-thinking-translator'
  'https://github.com/mouriya-s-lab/omp-codex-image-gen'
)

for plugin in "${plugins[@]}"; do
  omp install "$plugin"
done
