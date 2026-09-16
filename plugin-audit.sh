#!/usr/bin/env bash
# plugin-audit.sh — 对比 install-plugins.sh 的历史插件名与本机已装插件。
#
# 扫描范围：仅 install-plugins.sh 这一个脚本，提交范围 BASE..HEAD（含 BASE）。
# BASE 固定为版本号/git-ref 被清理成裸包名之后的第一个提交，早于它的带
# `@version` / `#sha` 的历史不参与，避免把同一插件的旧钉版当成不同插件。
# 归一后直接与 `omp plugin list --json` 对比并给出分类结论，无需再人工跑一遍。
set -euo pipefail

BASE="5974c4fa2f237b951befa935d45d8cd8efd5d30e"
SCRIPT="install-plugins.sh"

command -v omp >/dev/null 2>&1 || { printf '%s\n' 'omp 不在 PATH' >&2; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  printf '%s\n' '需在 omp-config 仓库内运行' >&2; exit 1; }
cd "$(git rev-parse --show-toplevel)"
git cat-file -e "${BASE}^{commit}" 2>/dev/null || {
  printf '%s\n' "基准提交 ${BASE} 不存在" >&2; exit 1; }

# 脚本条目 -> 归一化插件包名 key（与 omp plugin list 的 name 对齐）。
# 注意：git URL 用最后一段 basename 近似包名，个别仓库名 != package name 时会偏差，
# 归一结果仅作对比线索，最终以 omp plugin list 的 name 为准。
normalize() {
  local e="$1"
  e="${e%%#*}"                        # 去 git ref (#sha / #branch)
  case "$e" in
    *://*|git@*|*.git)                # URL / git 源 -> basename 去 .git
      e="${e##*/}"; e="${e%.git}" ;;
    @*)                               # scoped 包 @scope/name[@ver]
      local rest="${e#@}"
      case "$rest" in
        */*@*) e="@${rest%@*}" ;;     # @scope/name@ver -> @scope/name
        *)     e="@$rest" ;;
      esac ;;
    *@*) e="${e%@*}" ;;               # name@ver -> name
  esac
  [ -n "$e" ] && printf '%s\n' "$e"
}

# 从某个版本的脚本里抽取 plugins=( ... ) 内的单引号条目。
entries_at() {
  git show "${1}:${SCRIPT}" 2>/dev/null \
    | awk '/plugins=\(/{f=1;next} f&&/^[[:space:]]*\)/{f=0} f{print}' \
    | grep -oE "'[^']+'" | tr -d "'" || true
}

norm_stream() { while IFS= read -r e; do [ -n "$e" ] && normalize "$e"; done; }

hist_keys() {
  {
    entries_at "$BASE"
    for c in $(git rev-list "${BASE}..HEAD" -- "$SCRIPT"); do entries_at "$c"; done
  } | norm_stream | sort -u
}
head_keys() { entries_at HEAD | norm_stream | sort -u; }
installed_keys() {
  omp plugin list --json \
    | grep -oE '"name"[[:space:]]*:[[:space:]]*"[^"]+"' \
    | sed -E 's/.*:[[:space:]]*"([^"]+)".*/\1/' | sort -u
}

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
hist_keys      > "$tmp/hist"
head_keys      > "$tmp/head"
installed_keys > "$tmp/inst"
comm -23 "$tmp/hist" "$tmp/head" > "$tmp/removed"      # 历史有、当前脚本已移除
comm -23 "$tmp/head" "$tmp/inst" > "$tmp/missing"      # 脚本要、本机缺
comm -12 "$tmp/removed" "$tmp/inst" > "$tmp/uninst"    # 已移除且本机仍装（卸载候选）
comm -23 "$tmp/inst" "$tmp/hist" > "$tmp/unmanaged"    # 本机装、脚本历史从未登记
comm -12 "$tmp/head" "$tmp/inst" > "$tmp/synced"       # 已同步

section() { printf '\n== %s ==\n' "$1"; if [ -s "$2" ]; then cat "$2"; else printf '(无)\n'; fi; }

printf '基准提交: %s\n' "$BASE"
printf '脚本: %s\n' "$SCRIPT"
section '已安装（omp plugin list）' "$tmp/inst"
section '脚本当前列表（HEAD）' "$tmp/head"
section '[安装] 脚本要求但本机缺失 -> 跑 ./install-plugins.sh' "$tmp/missing"
section '[卸载候选] 历史存在过、当前已移除、本机仍装 -> 询问用户后 omp plugin uninstall <name>' "$tmp/uninst"
section '[仅供参考] 历史存在过、当前脚本已移除（全部）' "$tmp/removed"
section '[保留] 本机安装、脚本历史从未登记（用户自装，勿动）' "$tmp/unmanaged"
section '[已同步] 脚本与本机一致' "$tmp/synced"
