#!/usr/bin/env bash
set -euo pipefail

command -v omp >/dev/null 2>&1 || {
  printf '%s\n' 'omp is required on PATH' >&2
  exit 1
}

plugins=(
  'https://github.com/giuseppe-trisciuoglio/pi-rules#f99bf49'
  'pi-bro@0.9.1'
  'pi-commandcode-provider@0.5.1'
  'pi-patty-bg-tasks@1.1.6'
  'pi-rewind@0.5.0'
  'pi-schedule@0.3.6'
)

for plugin in "${plugins[@]}"; do
  omp install "$plugin"
done
