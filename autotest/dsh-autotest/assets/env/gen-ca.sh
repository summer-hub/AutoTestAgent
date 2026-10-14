#!/usr/bin/env bash
# 生成本地自签 CA 与服务端证书（envkit 脚本资产：gen_ca · POSIX 侧）
#
# 与 gen-ca.ps1 同一份契约（src/services/envkit/builtin.ts::gen_ca）。
# 网络类三方库要测 HTTPS，就必须有可控的 CA：官方证书过期/换域名都会让测试突然全失败，
# 而自签 CA + 固定 SAN 是唯一可复现的路。
#
# 退出码：0 成功 · 1 业务失败 · 2 工具缺失 · 3 超时 · 4 取消
#
# 纪律（与 .ps1 逐条对齐）：
#   · 幂等：已存在且未临期（30 天）的 CA 直接复用；
#   · 产物必须真存在：声明了几个证书文件就要真的 stat 到；
#   · 私钥权限收敛（chmod 600）；
#   · 到期时间如实输出，供上层做临期告警。
set -uo pipefail

OUT_DIR=""; CN="AutoTest Local CA"; SAN="localhost,127.0.0.1"; DAYS=825
while [[ $# -gt 0 ]]; do
  case "$1" in
    -outDir|--out-dir) OUT_DIR="$2"; shift 2 ;;
    -cn|--cn) CN="$2"; shift 2 ;;
    -san|--san) SAN="$2"; shift 2 ;;
    -days|--days) DAYS="$2"; shift 2 ;;
    *) echo "[gen_ca] 未知参数：$1" >&2; exit 2 ;;
  esac
done

[[ -z "$OUT_DIR" ]] && { echo "[gen_ca] outDir 必填" >&2; exit 2; }
command -v openssl >/dev/null 2>&1 || { echo "[gen_ca] 未检测到 openssl。请安装 OpenSSL 并配置 PATH。" >&2; exit 2; }

[[ "$DAYS" =~ ^[0-9]+$ ]] && [[ "$DAYS" -ge 1 ]] || { echo "[gen_ca] days 必须为正：$DAYS" >&2; exit 1; }
[[ -n "$SAN" ]] || { echo "[gen_ca] san 不能为空（服务端证书需要 SAN，否则现代客户端拒绝）" >&2; exit 1; }

mkdir -p "$OUT_DIR" || exit 2
BASE=$(echo "$CN" | tr -cs 'a-zA-Z0-9' '-' | tr 'A-Z' 'a-z' | sed 's/^-*//;s/-*$//')
[[ -z "$BASE" ]] && BASE="autotest-local-ca"

CA_CRT="$OUT_DIR/${BASE}-ca.crt"
CA_KEY="$OUT_DIR/${BASE}-ca.key"
SRV_CRT="$OUT_DIR/${BASE}-server.crt"
SRV_KEY="$OUT_DIR/${BASE}-server.key"
SRV_CSR="$OUT_DIR/${BASE}-server.csr"
SRV_EXT="$OUT_DIR/${BASE}-server.ext"

echo "[gen_ca] outDir=$OUT_DIR cn=$CN san=$SAN days=$DAYS"

# ---- 幂等：CA 已存在且未临期 → 复用 ----
cert_not_expiring() {
  local crt="$1" warn="$2"
  [[ -f "$crt" ]] || return 1
  local end
  end=$(openssl x509 -in "$crt" -noout -enddate 2>/dev/null | sed 's/^notAfter=//') || return 1
  [[ -n "$end" ]] || return 1
  local end_ts now_ts
  end_ts=$(date -d "$end" +%s 2>/dev/null || date -j -f "%b %d %H:%M:%S %Y %Z" "$end" +%s 2>/dev/null) || return 1
  now_ts=$(date +%s)
  (( end_ts > now_ts + warn * 86400 ))
}

if cert_not_expiring "$CA_CRT" 30 && cert_not_expiring "$SRV_CRT" 30; then
  echo "[gen_ca] 复用已有且未临期的 CA（幂等）：$CA_CRT"
  EXPIRES=$(openssl x509 -in "$CA_CRT" -noout -enddate 2>/dev/null | sed 's/^notAfter=//')
  echo "CA_CERT_PATH=$CA_CRT"
  echo "SERVER_CERT_PATH=$SRV_CRT"
  echo "CA_EXPIRES_AT=$EXPIRES"
  exit 0
fi

# ---- 生成 CA ----
if ! cert_not_expiring "$CA_CRT" 0; then
  openssl genrsa -out "$CA_KEY" 4096 2>&1 || { echo "[gen_ca] 生成 CA 私钥失败" >&2; exit 1; }
  openssl req -x509 -new -nodes -key "$CA_KEY" -sha256 -days "$DAYS" -out "$CA_CRT" \
    -subj "/CN=$CN" 2>&1 || { echo "[gen_ca] 生成 CA 证书失败" >&2; exit 1; }
fi

# ---- 生成服务端证书（带 SAN）----
if ! cert_not_expiring "$SRV_CRT" 0; then
  openssl genrsa -out "$SRV_KEY" 2048 2>&1 || { echo "[gen_ca] 生成服务端私钥失败" >&2; exit 1; }

  # SAN 扩展：现代客户端（含真机）只认 SAN，不认 CN
  { echo "authorityKeyIdentifier=keyid,issuer"
    echo "basicConstraints=CA:FALSE"
    echo "keyUsage = digitalSignature, keyEncipherment"
    echo "extendedKeyUsage = serverAuth"
    echo "subjectAltName = @alt_names"
    echo "[alt_names]"
    i=1
    IFS=',' read -ra ENTRIES <<< "$SAN"
    for e in "${ENTRIES[@]}"; do
      e=$(echo "$e" | xargs)
      [[ -z "$e" ]] && continue
      if [[ "$e" =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then echo "IP.$i = $e"; else echo "DNS.$i = $e"; fi
      i=$((i+1))
    done
  } > "$SRV_EXT"

  FIRST_SAN=$(echo "$SAN" | cut -d',' -f1 | xargs)
  openssl req -new -key "$SRV_KEY" -out "$SRV_CSR" -subj "/CN=$FIRST_SAN" 2>&1 \
    || { echo "[gen_ca] 生成服务端 CSR 失败" >&2; exit 1; }
  openssl x509 -req -in "$SRV_CSR" -CA "$CA_CRT" -CAkey "$CA_KEY" -CAcreateserial \
    -out "$SRV_CRT" -days "$DAYS" -sha256 -extfile "$SRV_EXT" 2>&1 \
    || { echo "[gen_ca] 签发服务端证书失败" >&2; exit 1; }
fi

# ---- 产物校验 ----
for f in "$CA_CRT" "$CA_KEY" "$SRV_CRT" "$SRV_KEY"; do
  [[ -f "$f" ]] || { echo "[gen_ca] 声明产物未生成：$f" >&2; exit 1; }
  [[ -s "$f" ]] || { echo "[gen_ca] 产物为空文件：$f" >&2; exit 1; }
done

# 私钥权限收敛
chmod 600 "$CA_KEY" "$SRV_KEY" 2>/dev/null || echo "[gen_ca] 提示：chmod 私钥失败（忽略）"

EXPIRES=$(openssl x509 -in "$CA_CRT" -noout -enddate 2>/dev/null | sed 's/^notAfter=//')
echo "[gen_ca] 完成：CA=$CA_CRT 到期=$EXPIRES"
echo "CA_CERT_PATH=$CA_CRT"
echo "SERVER_CERT_PATH=$SRV_CRT"
echo "CA_EXPIRES_AT=$EXPIRES"
exit 0
