#!/usr/bin/env bash
# @file check-headers.sh
# @author zhangbaohong
# @date 2026-09-17
# @description 注释规范检查：遍历 git 跟踪的 .ts/.py 源文件与 aivideo 启动脚本，
#              校验 @author zhangbaohong、仓库 URL 以及"函数头数量 ≥ 顶层函数数量"。
# @see https://github.com/1241751430/AIVideo.git
#
# Function coverage is a heuristic: for TypeScript we count top-level
# `function` declarations, for Python top-level and 4-space-indented `def`s,
# and require at least one `@author zhangbaohong` marker per function plus one
# for the file header. Deeper constructs (class methods, nested closures) are
# covered by code review; the markers make omission in review visible.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

EXPECTED_AUTHOR="@author zhangbaohong"
EXPECTED_URL="https://github.com/1241751430/AIVideo.git"

violations=0

check_file() {
  local file="$1"
  local funcs
  case "$file" in
    *.ts)
      funcs=$(grep -cE '^(export (async )?function|async function|function )' "$file" || true)
      ;;
    *.py)
      funcs=$(grep -cE '^(def |    def )' "$file" || true)
      ;;
    *)
      funcs=0
      ;;
  esac

  local authors urls
  authors=$(grep -cF "$EXPECTED_AUTHOR" "$file" || true)
  urls=$(grep -cF "$EXPECTED_URL" "$file" || true)

  if [ "$authors" -eq 0 ] || [ "$urls" -eq 0 ]; then
    echo "missing header: $file (author=$authors url=$urls)"
    violations=$((violations + 1))
  elif [ "$authors" -le "$funcs" ]; then
    echo "missing function docs: $file (functions=$funcs authors=$authors, need authors > functions)"
    violations=$((violations + 1))
  fi
}

while IFS= read -r tracked; do
  case "$tracked" in
    *.ts|*.py|aivideo) check_file "$tracked" ;;
    *) ;;
  esac
done < <(git ls-files)

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "check-headers: $violations file(s) violate the annotation standard."
  exit 1
fi
echo "check-headers: all tracked sources carry the @author zhangbaohong headers."
