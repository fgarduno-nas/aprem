# Consola web del VPS: respaldo y simulación APREM

Estos bloques se ejecutan como root en la consola web del proveedor, host confirmado srv1780851. Proyecto: /opt/egem-visor-morelos. No requieren configurar SSH, actualizar el checkout, reiniciar PM2 ni modificar usuarios. El script no contiene modo de aplicación.

El script identifica una única instancia PM2 online que ejecute backend/src/server.js, verifica que el daemon ya esté activo (no inicia otro), combina el entorno inicial del proceso con backend/.env siguiendo dotenv y conecta con el Prisma instalado. Confirma mediante SELECT que se conecta a la base configurada. No imprime su nombre, host, usuario, URL, contenido de entorno, correos ni contraseñas.

## 1. Preparar herramienta e inspeccionar en solo lectura

Usar la URL del commit APREM publicado, que se fija en el informe final. No usar main móvil para una operación de respaldo. Sustituir RELEASE_SHA por el SHA completo del informe.

```bash
umask 077
APREM_RELEASE=RELEASE_SHA
APREM_TOOL=/tmp/aprem-production-preflight-${APREM_RELEASE}.mjs
curl --fail --silent --show-error --location "https://raw.githubusercontent.com/fgarduno-nas/aprem/${APREM_RELEASE}/ops/aprem-production-preflight.mjs" --output "$APREM_TOOL"
node "$APREM_TOOL" inspect
```

La descarga solo escribe el script en /tmp. inspect no escribe en la base ni crea respaldos. Busca manifiestos de respaldo bajo /var/backups/aprem, comprueba correspondencia con la base/host efectivos, antigüedad menor de 24h, SHA256 del archivo, listado pg_restore y evidencia de restauración previa. También busca archivos recientes de respaldo (sin seguir enlaces simbólicos, hasta profundidad 4 y 2000 entradas) en /var/backups, /root/backups y /opt/egem-visor-morelos/backups. Si encuentra un archivo de otra herramienta pero no puede acreditar su restauración, devuelve RESPALDO_RECIENTE_SIN_VERIFICAR. La búsqueda no cubre almacenamiento externo ni rutas desconocidas. Un respaldo histórico de otra herramienta/ruta no se acepta automáticamente: sin su manifiesto, procedencia y ensayo de restauración no se puede declarar verificado.

Salida compartible: {"respaldo":"VERIFICADO_MENOS_24H","candidatas":null,"colisiones":null} o SIN_RESPALDO_RECIENTE_VERIFICADO. Un estado NO_VERIFICADO_ERROR_DE_COMPROBACION significa que no se pudo establecer el entorno, la conexión o una comprobación; no equivale a afirmar que la base no tenga respaldos. Compartir solo esa línea. No enviar pm2 jlist, .env ni logs de autenticación.

## 2. Solo si no existe respaldo verificado: generar y comprobar

```bash
node "$APREM_TOOL" backup
```

Crea un directorio privado aleatorio /var/backups/aprem/backup-*, archivo database.dump en formato custom (0600) y manifiesto verified.json (0600), sin sobrescribir otros respaldos. Usa pg_dump con credenciales exclusivamente en el entorno del subproceso. Verifica espacio libre con margen para el dump y una copia restaurada. pg_dump toma su snapshot consistente; no bloquea deliberadamente el servicio ni altera sus datos, pero consume I/O y espacio. Ejecutar en una franja tranquila.

Comprueba pg_restore --list y restaura el dump completo en una base LOCAL temporal con nombre aprem_restorecheck_* aleatorio, usando runuser postgres con entorno PostgreSQL limpio y socket local /var/run/postgresql:5432 (no hereda PGHOST/PGSERVICE del shell), --no-owner y --no-privileges. Verifica lectura de la tabla User y elimina únicamente esa base temporal creada por el script. Nunca restaura sobre producción. El manifiesto se escribe solo si restauración, comprobación y limpieza terminaron bien. Requiere herramientas PostgreSQL compatibles con el servidor, usuario local postgres, permisos CREATE DATABASE y espacio para la restauración. Si falta un requisito, termina como no verificado; no sustituirlo por una comprobación superficial. El dump fallido puede conservarse privado para diagnóstico, sin declararlo recuperable.

La verificación acredita datos/esquema del dump, no configuración de roles globales, servicio, extensiones del sistema, uploads ni recuperación PITR. Para la migración de correos se conserva la misma base y sus relaciones; no se modifica la infraestructura ni el esquema. No eliminar respaldos anteriores.

## 3. Bloque separado: únicamente simulación de correos

```bash
node "$APREM_TOOL" simulate
```

Abre una transacción READ ONLY, consulta solo email, cuenta el sufijo exacto @egem.morelos y detecta destinos ocupados o repetidos sin distinguir mayúsculas. No modifica cuentas, no ejecuta seed ni migraciones Prisma, y no imprime correos. Puede simular aunque aún no se haya logrado verificar un respaldo, pero eso NO autoriza aplicar cambios.

Salida compartible: {"respaldo":"VERIFICADO_MENOS_24H","candidatas":N,"colisiones":C}. Compartir solo esta línea y la del respaldo. Si falla, los contadores son null y el proceso devuelve código 1; no interpretarlos como cero. Con estos resultados se decide la ventana y la validación de acceso; no hay bloque --apply en este documento. Cualquier colisión o necesidad de reemplazar cuentas debe revisarse antes de crear usuarios.
