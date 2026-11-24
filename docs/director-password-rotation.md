# Rotación selectiva de contraseñas de Director APREM

## Estado y alcance

Preparado para la consola web de Hostinger. **No se ha aplicado en producción.** Ejecutar únicamente la simulación y compartir sus conteos; la aplicación requiere confirmación posterior del usuario. La rama codex/director-password-rotation no modifica main ni despliega/reinicia el backend del VPS.

El rol real de Director es DATA_PROVIDER. Se examinan todas sus cuentas por comparación bcrypt con la contraseña anterior introducida de forma oculta. No se usa el número 38 de la migración de correos. Se incluyen activas e inactivas y también filas marcadas deletedAt: se conservan exactamente sus estados; eliminados_incluidos es un subconjunto informativo, no un grupo adicional.

Se importan hashPassword y verifyPassword del backend INSTALADO, su resetPasswordSchema y sus constantes de rol. La nueva contraseña cumple la validación existente y además no supera 72 bytes UTF-8 para evitar truncamiento bcrypt; se rechaza si es igual o equivalente a la anterior. Cada cuenta recibe una llamada independiente a hashPassword, con la configuración y sal aleatoria del proyecto.

El payload de auditoría se extrae al módulo común buildAuditRecord y createAuditLog mantiene la API previa, con cliente Prisma opcional. La herramienta usa ese mismo constructor y USER_UPDATED con passwordResetByAdmin; inserta auditoría mediante el cliente de la transacción, sin llamar al reset HTTP repetidamente ni escribir auditoría fuera de la transacción. Esta refactorización está en la rama de preparación; no hace falta instalarla en el backend para usar la herramienta y su pequeño módulo adjunto.

## Identificación de producción y entrada oculta

Se localiza una única instancia PM2 online que ejecuta /opt/egem-visor-morelos/backend/src/server.js, sin iniciar un daemon nuevo. Se combina su entorno inicial de /proc con el archivo .env y se exige que .env y los módulos de configuración/contraseña/rol/validación no hayan cambiado desde el arranque: si hay ambigüedad, se detiene en lugar de adivinar qué base usa el proceso. Se comprueba current_database() frente a esa configuración y se vincula el comprobante y el respaldo a su identidad (host/puerto/base), sin imprimirla. No se usa la base de desarrollo local ni se solicita una URL con credenciales.

Python 3 getpass lee exclusivamente desde /dev/tty. La contraseña viaja a Node en un descriptor IPC privado, nunca como argumento, variable de entorno, archivo, stdout o log. Sin terminal compatible o al cancelar, se detiene; no usa entrada visible. No se prometen borrados absolutos de cadenas dentro del recolector de memoria de JavaScript.

## Preparación y simulación — ejecutar ahora

Usar el commit inmutable facilitado en el chat en lugar de REVISION; las instrucciones locales entregadas ya lo incluyen.

```bash
umask 077
APREM_PW_DIR=$(mktemp -d /var/tmp/aprem-directores.XXXXXXXX) &&
curl -fsSL 'https://raw.githubusercontent.com/fgarduno-nas/aprem/REVISION/ops/director-passwords.mjs' -o "$APREM_PW_DIR/director-passwords.mjs" &&
curl -fsSL 'https://raw.githubusercontent.com/fgarduno-nas/aprem/REVISION/backend/src/shared/services/audit-record.js' -o "$APREM_PW_DIR/aprem-audit-record.mjs" &&
env -u DEBUG -u NODE_DEBUG -u NODE_OPTIONS node "$APREM_PW_DIR/director-passwords.mjs" simulate "$APREM_PW_DIR/receipt.json"
```

Pide solo la contraseña anterior, con entrada oculta. La base se consulta con una transacción READ ONLY. No hay logins de prueba contra cuentas reales, escrituras de auditoría ni modificaciones de cuentas. Se guarda únicamente un comprobante privado en el VPS (directorio 0700, archivo 0600): identidad de base, IDs internos y huellas HMAC del hash/rol/estado de las candidatas, con clave aleatoria privada. No guarda contraseñas, hashes bcrypt ni correos. Este archivo no se sube a Git ni se comparte. Es necesario para detectar una sustitución de candidatas aunque la cantidad coincida. No borrarlo ni sobrescribirlo después de la confirmación; una nueva simulación sustituye el comprobante y requiere una nueva revisión.

Salida: estado SIMULACION y conteos directores_activos, directores_inactivos, con_anterior, con_otra y eliminados_incluidos. Invariantes: activos + inactivos = con_anterior + con_otra; eliminados_incluidos es un subconjunto. Si con_anterior = 0 no hay cambio que aplicar. Los conteos de producción todavía se desconocen. Compartir solo el JSON; no ejecutar cat del comprobante, .env, PM2 o archivos de respaldo.

Mantener la misma consola para conservar APREM_PW_DIR. Si se cierra, el directorio privado sigue en /var/tmp; recuperar su ruta local sin compartir contenido y comprobar qué simulación se está revisando. No eliminar locks a ciegas si una operación se interrumpió.

## Respaldo antes de aplicar

La aplicación exige el manifiesto reciente y restaurado de /var/backups/aprem, correspondiente a la misma base. Revalida antigüedad menor de 24 horas, SHA256 del dump, pg_restore --list y la constancia de restauración temporal exitosa. Si falta o caducó, se detiene sin cambiar cuentas. No lo genera automáticamente.

Para inspeccionar/generar con la herramienta de respaldo ya usada en esta transición:

```bash
curl -fsSL 'https://raw.githubusercontent.com/fgarduno-nas/aprem/34a32db60697d6e9c549fb01e14cc478b725301b/ops/aprem-production-preflight.mjs' -o "$APREM_PW_DIR/backup-check.mjs" &&
env -u DEBUG -u NODE_DEBUG -u NODE_OPTIONS node "$APREM_PW_DIR/backup-check.mjs" inspect
```

Si hace falta, ejecutar por separado `env -u DEBUG -u NODE_DEBUG -u NODE_OPTIONS node "$APREM_PW_DIR/backup-check.mjs" backup`. Esa herramienta conserva respaldos previos, genera un dump privado y lo restaura en una base temporal local antes de declararlo verificado. No restaura sobre la base activa. El respaldo de una operación anterior no se presume vigente hoy.

## Aplicación — preparada, NO ejecutar hasta confirmación posterior

```bash
env -u DEBUG -u NODE_DEBUG -u NODE_OPTIONS node "$APREM_PW_DIR/director-passwords.mjs" apply "$APREM_PW_DIR/receipt.json" --confirmed
```

Pide contraseña anterior, nueva y repetición de la nueva, todas ocultas. El comprobante debe tener menos de 24 horas. Genera hashes independientes fuera del bloqueo; después entra en una transacción Serializable y bloquea escrituras de Role y User. Vuelve a verificar el rol actual, compara cada Director con la contraseña anterior y exige los mismos IDs/huellas que en la simulación. Un cambio de contraseña, incluso rehash de la misma clave, de rol o de estado de una candidata provoca detención y exige nueva simulación. Una contraseña personalizada que siga fuera de las candidatas se conserva. Durante el bloqueo pueden esperar las escrituras de usuarios y el registro de nuevos inicios de sesión; el mapa público no se modifica.

Solo escribe passwordHash mediante SQL parametrizado protegido por ID, rol y hash vigente. Preserva incluso updatedAt y comprueba todos los campos de todas las cuentas antes de confirmar; agrega auditoría sin contraseñas, hashes ni correos. Comprueba que las candidatas aceptan la nueva contraseña y rechazan la anterior. Si falla cualquier actualización/auditoría/verificación, la transacción se revierte. Si el transporte falla al confirmar, no se declara falsamente que hubo cero cambios: RESULTADO_NO_CONFIRMADO_NO_REPETIR requiere revisión, sin repetir automáticamente.

Éxito: estado APLICADA, respaldo VERIFICADO_MENOS_24H, actualizadas igual a con_anterior de la simulación revisada, con_anterior = 0, con_otra = total de Directores, y candidatas_del_lote_con_anterior = 0. Activos, inactivos y eliminados se conservan. El comprobante se marca applied con las huellas posteriores. Una segunda aplicación se detiene.

## Sesiones abiertas

El backend verifica contraseña bcrypt al iniciar sesión y emite un JWT con sub/rol. El middleware comprueba firma y vencimiento del token, sin comparar el hash de la contraseña con la base ni usar una versión de sesión. Cambiar la contraseña NO invalida los JWT existentes: seguirán válidos hasta el vencimiento configurado (8h por defecto si no se cambió JWT_EXPIRES_IN). No se rota JWT_SECRET, pues cerraría también sesiones de otros roles. Cerrar sesión y entrar de nuevo prueba la nueva contraseña; las cuentas inactivas permanecen inactivas. No se usaron credenciales supuestas para probar producción.

## Reversión selectiva

Conservar el comprobante aplicado, dentro de su vigencia de 24h desde la simulación y con un respaldo reciente. Solo después de decidir la reversión:

```bash
env -u DEBUG -u NODE_DEBUG -u NODE_OPTIONS node "$APREM_PW_DIR/director-passwords.mjs" rollback "$APREM_PW_DIR/receipt.json" --confirmed
```

Pide primero la contraseña APREM aplicada, luego la anterior que se quiere restaurar y su repetición, con entrada oculta. Restaura la contraseña lógica anterior con un NUEVO hash independiente, no el hash binario anterior. Solo actúa sobre los IDs de ese lote si su rol/estado y hash actual siguen coincidiendo con las huellas posteriores. Si una cuenta personalizó su contraseña o cambió de rol/estado después de aplicar, se detiene TODO el lote, sin sobrescribirla. Conserva los eventos previos de auditoría y añade USER_UPDATED de reversión. En esta salida con_anterior/con_otra se refieren a la clave de origen de la reversión (APREM); actualizadas indica cuentas revertidas.

Si el comprobante falta, caducó, hay cambios posteriores o un commit incierto, detenerse y revisar el lote de auditoría/backup en entorno privado. No restaurar toda la base de producción ni ejecutar resets masivos indiscriminados: afectarían cambios posteriores y contraseñas personalizadas. El dump verificado permite recuperación dirigida y revisión en una base aislada, sin mostrar hashes ni credenciales. La reversión tampoco revoca JWT ya emitidos.

## Pruebas

- 508 pruebas del proyecto aprobadas con la refactorización compatible de auditoría.
- PostgreSQL aislado con usuarios ficticios y contraseñas aleatorias generadas en memoria: simulación sin escrituras; tres candidatas con sales distintas; personalizadas, Admin y Visitante intactos; activación y borrado lógico conservados; nuevas credenciales aceptadas y anteriores rechazadas por login real; JWT previo sigue válido; huellas detectan cambios de rol/hash y sustitución de candidatas con igual cantidad; respaldo ausente/vencido y simulación caducada bloquean; fallo de auditoría revierte todo; reversión dirigida y rechazo ante personalización posterior; reset concurrente espera al bloqueo y no se pierde. El comprobante y auditoría no contienen contraseñas, hashes bcrypt ni correos.
- No se conoce aún el resultado de la simulación de Directores en producción; no se ha aplicado la rotación.
