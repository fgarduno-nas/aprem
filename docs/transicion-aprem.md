# Estado de la transición de producción APREM

La autorización de publicación fue recibida. La migración de cuentas quedó suspendida por instrucción posterior del usuario hasta revisar el respaldo y los resultados de una simulación desde la consola web del VPS. No hay cuenta de prueba autorizada confirmada.

## Base de publicación revisada

La copia local original parte de b504e89, anterior a producción. Este release se preparó en worktree aislado sobre main 4456e06232ceba4b5498fd34f9ee1c84a79c7e2d, confirmado por deployment 7318068432 y workflow Pages 40226464821 exitosos. La rama remota codex/aprem-rollback-4456e06 conserva ese estado.

Se mantienen la exportación PNG existente (2047×1576, leyenda, escala, norte y logotipo), cartografía, capas y funciones de producción. Solo se cambia su encabezado EGEM por APREM y el prefijo del archivo a aprem_morelos_. No se incorporan los cambios locales previos de popups, medición, fondos o diseño de la copia original. La guía refleja Guardar imagen del mapa y los controles móviles Mostrar/Minimizar de esta versión.

La publicación conserva https://api-egem.geodinamica.mx/api/v1 y el protocolo interno X-EGEM-Classification-Version; no cambia DNS, backend instalado, esquema, uploads ni datos. APREM_API_BASE_URL queda como variable de Pages opcional; vacía conserva el endpoint vigente. Las referencias EGEM de compatibilidad siguen siendo necesarias para almacenamiento, caché, cabeceras/procesamiento, nombres internos y documentación histórica.

## Redirección y reversión

Antes de renombrar se creó fgarduno-nas/aprem-legacy-redirect con index.html y 404.html que redirigen a /aprem/, y se verificó su build Pages. Tras renombrar el repositorio principal a aprem, ese repositorio de redirección ocupa egem-visor-morelos. La redirección es HTML/JavaScript, no HTTP 301; mantiene query/hash con JavaScript y un enlace alternativo. GitHub Pages puede necesitar unos minutos para reconstruir el enlace anterior.

Reversión preferida: mantener ambos nombres y publicar en aprem el árbol del commit 4456e06 mediante un commit de restauración (git restore --source=4456e06 en un checkout limpio, revisar y confirmar); el enlace anterior sigue apuntando a aprem. No reset ni force-push. Alternativa: renombrar primero el repositorio de redirección a un nombre temporal, devolver el repositorio principal a egem-visor-morelos y relanzar su workflow. Revisar disponibilidad de nombres y remotos antes de hacerlo. La API no cambia y no requiere reversión.

El proceso de Pages publica index/css/js/shared/assets/data; los scripts de cuentas y documentos no se sirven como parte del visor. No se ejecuta seed para cambiar correos. Las instrucciones de consola del VPS se documentan en docs/consola-aprem.md; sus salidas están limitadas al estado del respaldo y cantidades.

## Cuentas y referencias conservadas

El script backend/scripts/migrate-aprem-emails.js está preparado pero NO se ejecuta en producción. Prioriza actualizar las cuentas existentes por ID, conserva hash, rol, estado y relaciones, detecta colisiones sin distinguir mayúsculas y usa una transacción Serializable con bloqueo de User y auditoría USER_UPDATED. Sin argumentos solo simula; --apply requiere una decisión posterior del usuario. No crear cuentas de reemplazo sin revisar cada caso. No ejecutar seed: puede crear otro administrador o restablecer contraseñas.

El sufijo debe terminar exactamente en @egem.morelos; solo se cambia a @aprem.morelos. Cuentas cuyo prefijo almacenado contenga mayúsculas deben revisarse antes de aplicar porque el login normaliza a minúsculas. El proceso conserva ese prefijo y no resuelve esa anomalía automáticamente. JWT existentes mantienen el email anterior hasta caducar; firma/sub/rol siguen vigentes. Cerrar sesión y entrar de nuevo actualiza la identidad. No hay cuenta de prueba productiva confirmada; no se usan cuentas demo ni se prueban contraseñas supuestas.

Para revertir correos, suspender escrituras, seleccionar solo los eventos de auditoría del lote aprem-email-v1, verificar email actual contra newEmail y comprobar que previousEmail está libre; restaurar por entityId dentro de una transacción con bloqueo y nueva auditoría. No hacer sustitución inversa global que afectaría cuentas APREM preexistentes. Requiere respaldo restaurable y revisión de cambios posteriores.

Permanecen las claves egem-session, egem-layer-prefs-v1, egem-managed-users-v1, egem-topbar-mode-v1; el fallback __EGEM_CONFIG__; cachés/protocolos GOES egem.local, egem-goes-ir-frames-v1, x-egem-* y __egem*; identificadores de procesamiento/perfil egem-ordinal-five-level; cabecera X-EGEM-Classification-Version e idempotencia egem-upload; nombre npm egem-backend, contenedor egem-postgis y base egem_backend. Son compatibilidad interna y servicio existente, no marca pública. Los nombres/rutas históricos de documentos y las referencias del procedimiento de reversión se conservan.

Se revisaron las tres imágenes de assets: contienen identidad institucional Morelos/Gobierno/CEPCM, sin EGEM/VGEM. No se necesita reemplazo oficial de una imagen con marca antigua.

## Validación del release

508 pruebas de unidad/contrato/integración HTTP aprobadas sobre esta base, con entorno sintético y Prisma generado. Se incluyen las pruebas del exportador existente y se actualizan únicamente sus expectativas de APREM y nombres PNG. La prueba PostgreSQL del mecanismo de migración ya pasó en una base local aislada durante la preparación; no equivale a migrar o verificar la base de producción.

El registro final de despliegue y evidencias se guarda en docs/resultado-aprem.md. Falta ejecutar en la consola del proveedor la inspección/respaldos/simulación de docs/consola-aprem.md; hasta recibir esos resultados no se decide una ventana de migración ni una prueba de acceso con cuenta autorizada.
