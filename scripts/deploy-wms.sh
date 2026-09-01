#!/usr/bin/env bash
#
# deploy-wms.sh — aplica el cambio de base de la feature WMS export a PROD.
#
# Fecha: 2026-09-01
#
# Qué hace, en orden:
#   1. genera un token de portal nuevo (32 bytes aleatorios, hex),
#   2. lee DIRECT_URL de apps/web/.env.production.local (sin imprimirlo),
#   3. chequea que la base esté como se espera ANTES de escribir,
#   4. corre scripts/sql/wms-deploy.sql en UNA transacción,
#   5. imprime SOLO el link del portal y los conteos de verificación.
#
# Lo único secreto que sale por pantalla es el link del portal, que es el
# entregable: ese link ES la credencial del cliente. Nada de DIRECT_URL, ni de
# la contraseña de Postgres, ni del hash. No queda escrito en ningún archivo:
# si se pierde, se borra la fila y se corre esto de nuevo (ver el ROLLBACK de
# scripts/sql/wms-deploy.sql).
#
# 🔴 Es IRREVERSIBLE en el sentido práctico: crea una tabla y una columna en la
# base de producción. Es aditivo y no borra nada, pero no lo corras "a ver qué
# pasa". El rollback está documentado en scripts/sql/wms-deploy.sql.
#
# Uso:
#   bash scripts/deploy-wms.sh              # aplica
#   DRY_RUN=1 bash scripts/deploy-wms.sh    # sólo los chequeos previos
#
# Requiere `psql` en el PATH (viene con postgresql-client / brew install libpq).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/apps/web/.env.production.local"
SQL_FILE="$ROOT/scripts/sql/wms-deploy.sql"

fail() { echo "ERROR: $*" >&2; exit 1; }

command -v psql >/dev/null 2>&1 || fail "no encuentro psql en el PATH."
command -v openssl >/dev/null 2>&1 || fail "no encuentro openssl en el PATH."
[[ -f "$ENV_FILE" ]] || fail "no existe $ENV_FILE"
[[ -f "$SQL_FILE" ]] || fail "no existe $SQL_FILE"

# Las credenciales entran al entorno del script y NUNCA se imprimen. `set +x`
# explícito por si alguien invoca esto con `bash -x`.
set +x
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

[[ -n "${DIRECT_URL:-}" ]] || fail "DIRECT_URL no está definida en $ENV_FILE"

# DIRECT_URL tiene que ser el puerto 5432 (sin pgbouncer): el DDL no va por el
# pooler. Se chequea el puerto sin imprimir la URL.
case "$DIRECT_URL" in
  *:6543/*) fail "DIRECT_URL apunta al pooler (6543). El DDL va por el 5432." ;;
esac

PSQL=(psql "$DIRECT_URL" -v ON_ERROR_STOP=1 --no-psqlrc -q)

echo "── Chequeos previos ──"

# 1) La base es la que creemos y responde.
"${PSQL[@]}" -At -c "SELECT 1" >/dev/null || fail "no me puedo conectar a la base."

# 2) Nada de esto puede existir ya (si existe, el deploy ya se hizo).
YA=$("${PSQL[@]}" -At -c "
  SELECT
    (SELECT count(*) FROM information_schema.tables  WHERE table_name = 'LabelItem')
  + (SELECT count(*) FROM information_schema.columns WHERE table_name = 'Label' AND column_name = 'packSeq');
")
if [[ "$YA" != "0" ]]; then
  fail "LabelItem y/o Label.packSeq YA existen en esta base (contador=$YA). El deploy ya se aplicó — no lo corras de nuevo."
fi

# 3) client_portal_tokens existe y su forma es la que asume el INSERT. El
#    schema de esta tabla NO está en Prisma (vive sólo en prod), así que en vez
#    de asumir las columnas se pregunta: si hay alguna NOT NULL sin default
#    fuera de (token_hash, tenant_ids), el INSERT del SQL fallaría a mitad de
#    la transacción. Mejor enterarse acá.
EXTRA=$("${PSQL[@]}" -At -c "
  SELECT coalesce(string_agg(column_name, ', '), '')
  FROM information_schema.columns
  WHERE table_name = 'client_portal_tokens'
    AND is_nullable = 'NO'
    AND column_default IS NULL
    AND column_name NOT IN ('token_hash', 'tenant_ids');
")
if [[ -n "$EXTRA" ]]; then
  fail "client_portal_tokens tiene columnas obligatorias sin default que el INSERT no llena: $EXTRA. Actualizar scripts/sql/wms-deploy.sql antes de seguir."
fi

# 4) Tiene que haber EXACTAMENTE un tenant "Kinevia" (nombre exacto).
N_KIN=$("${PSQL[@]}" -At -c "SELECT count(*) FROM \"Tenant\" WHERE name = 'Kinevia';")
[[ "$N_KIN" == "1" ]] || fail "se esperaba 1 tenant llamado 'Kinevia' y hay $N_KIN."

YA_PORTAL=$("${PSQL[@]}" -At -c "
  SELECT count(*) FROM client_portal_tokens cpt
  JOIN \"Tenant\" t ON t.id = cpt.tenant_ids
  WHERE t.name = 'Kinevia';
")

echo "ok: LabelItem y packSeq no existen todavía"
echo "ok: client_portal_tokens tiene la forma esperada"
echo "ok: 1 tenant 'Kinevia' (portales actuales: $YA_PORTAL)"

if [[ -n "${DRY_RUN:-}" ]]; then
  echo ""
  echo "DRY_RUN=1 — no se escribió nada."
  exit 0
fi

# Token del portal: 32 bytes de /dev/urandom en hex (64 chars, URL-safe). El
# SQL guarda su sha256; el claro vive sólo en esta variable y en la línea que
# se imprime al final.
PORTAL_TOKEN="$(openssl rand -hex 32)"

echo ""
echo "── Aplicando wms-deploy.sql ──"
"${PSQL[@]}" -v portal_token="$PORTAL_TOKEN" -f "$SQL_FILE"

# Base del link: NEXTAUTH_URL del .env de producción, con el dominio público
# como red por si no estuviera.
BASE="${PORTAL_BASE_URL:-${NEXTAUTH_URL:-https://autoenvia.com}}"
BASE="${BASE%/}"

echo ""
if [[ "$YA_PORTAL" == "0" ]]; then
  echo "── Link del portal de Kinevia (anotalo, no se vuelve a mostrar) ──"
  echo "$BASE/cliente/$PORTAL_TOKEN"
else
  echo "Kinevia YA tenía portal ($YA_PORTAL). No se creó uno nuevo y el token"
  echo "generado se descarta: el link viejo sigue siendo el válido."
fi

echo ""
echo "Siguiente paso: prisma generate, después push a main (Vercel) y trigger"
echo "manual del worker en Render. Ver labelflow-ops/state-2026-09-01.md."
