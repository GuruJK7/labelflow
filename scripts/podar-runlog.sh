#!/usr/bin/env bash
# Poda del atraso de RunLog + devolución del espacio al disco.
#
# POR QUÉ EXISTE ESTE SCRIPT Y NO LO CORRIÓ CLAUDE: el clasificador de permisos
# bloquea una limpieza masiva contra producción, y con razón. El job
# `runlog-retention.job.ts` (desplegado el 2026-09-08) hace exactamente lo mismo
# solo, al bootear el worker y una vez por día — pero tarda mucho más, porque
# recorre la tabla una vez por lote, y **no devuelve el espacio al disco**:
# quitar filas en Postgres no achica el archivo. El VACUUM FULL de abajo sí, y
# es lo único que baja el número que mide Supabase.
#
# Medido el 2026-09-08 contra producción: 1.455.011 filas vencidas de
# 1.622.786. Quedan 167.775, de las cuales 16.219 son mensajes de negocio que
# NO se tocan (los que no empiezan con "[").
#
# El VACUUM FULL bloquea la tabla mientras corre. Con la tabla ya podada son
# segundos, no minutos. Durante ese rato el worker no puede escribir logs — los
# despachos siguen igual, porque esa escritura está envuelta en un catch.
#
#   bash scripts/podar-runlog.sh            # simulacro: sólo cuenta, no toca nada
#   bash scripts/podar-runlog.sh --aplicar  # ejecuta
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./apps/web/.env.production.local; set +a

# El MISMO criterio que usa runlog-retention.job.ts. Si cambia uno, cambia el otro.
FILTRO="message like '[%'
    and message not like '%BUG REPORT%'
    and message not like '%FEEDBACK%'
    and message not like '%AYUDA%'
    and ( (level in ('INFO','SUCCESS') and \"createdAt\" < now() - interval '7 days')
       or (level in ('WARN','ERROR')  and \"createdAt\" < now() - interval '30 days') )"

echo "=== antes ==="
psql "$DIRECT_URL" -At -F'|' -c "
select (select count(*) from \"RunLog\") filas,
       (select count(*) from \"RunLog\" where $FILTRO) alcanzadas,
       (select count(*) from \"RunLog\" where ($FILTRO) and message not like '[%') negocio_atrapado_debe_ser_0,
       pg_size_pretty(pg_total_relation_size('\"RunLog\"')) tabla,
       pg_size_pretty(pg_database_size(current_database())) base;"

if [ "${1:-}" != "--aplicar" ]; then
  echo
  echo "Simulacro: no se tocó nada. Corré con --aplicar para ejecutar."
  exit 0
fi

echo
echo "=== podando por lotes de 100.000 ==="
total=0
for i in $(seq 1 30); do
  n=$(psql "$DIRECT_URL" -At -c \
    "delete from \"RunLog\" where ctid in (select ctid from \"RunLog\" where $FILTRO limit 100000);" \
    | grep -oE '[0-9]+$' | tail -1)
  total=$((total + n))
  echo "  lote $i: $n (acumulado $total)"
  [ "$n" -eq 0 ] && break
done

echo
echo "=== VACUUM FULL: esto es lo que devuelve el espacio al disco ==="
psql "$DIRECT_URL" -c 'VACUUM FULL VERBOSE "RunLog";' 2>&1 | tail -3
psql "$DIRECT_URL" -c 'ANALYZE "RunLog";'

echo
echo "=== después ==="
psql "$DIRECT_URL" -At -F'|' -c "
select (select count(*) from \"RunLog\") filas,
       (select count(*) from \"RunLog\" where message not like '[%') mensajes_de_negocio,
       pg_size_pretty(pg_total_relation_size('\"RunLog\"')) tabla,
       pg_size_pretty(pg_database_size(current_database())) base;"
