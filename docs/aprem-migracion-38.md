# Aplicación guardada de 38 cuentas APREM

Este script es una herramienta de consola independiente. No se publica en main ni se despliega el visor para ejecutarlo. Se descarga por commit inmutable desde la rama codex/aprem-account-migration.

La única invocación que permite aplicar es `node archivo.mjs --apply-38`. Verifica el runtime del mismo backend /opt/egem-visor-morelos/backend y la identidad de base usada por el preflight. Dentro de una transacción Serializable, bloquea escrituras en User, vuelve a contar el sufijo literal y las colisiones sin distinguir mayúsculas y exige exactamente 38 y 0. Comprueba nuevamente identidad, restauración verificada, SHA256 y listado del respaldo, y antigüedad menor de 24h. Se detiene si hay prefijos que incumplen la normalización del login. No crea ni reemplaza cuentas.

SQL parametrizado modifica solo email: ID, passwordHash, rol, estado, municipio, fechas e historial previo se conservan. Agrega 38 eventos de auditoría con etiqueta aprem-email-v1 y lote aprem-38-guarded-v1, sin imprimirlos. Los metadatos restringidos de auditoría guardan correos anterior/nuevo para reversión. Antes de confirmar, compara todos los campos de todas las cuentas, exige 38 actualizadas y cero con el sufijo anterior; si algo falla revierte la transacción. Revisa de nuevo vigencia del respaldo antes del commit. Tras confirmar hace una consulta adicional de remanentes.

Una segunda ejecución encuentra cero candidatas y se detiene: no duplica ni repite cambios. Un fallo de transporte durante COMMIT podría dejar resultado incierto; por eso RESULTADO_NO_CONFIRMADO_NO_REPETIR no declara cero cambios ni reintenta. APlicada con comprobación posterior pendiente indica que el commit sí terminó y falta la lectura final. Compartir únicamente el JSON, sin repetir automáticamente ante estados pendientes o inciertos.

Resultado normal: {"estado":"APLICADA","respaldo":"VERIFICADO_MENOS_24H","candidatas":38,"colisiones":0,"actualizadas":38,"restantes_sufijo_anterior":0}.

Validación: prueba real en una base PostgreSQL local temporal con esquema vigente: conteo modificado, colisión, respaldo ausente/vencido, rollback al fallar auditoría, actualización email-only, conservación de todas las columnas/fechas, roles/estado e historial y login real con contraseña existente; repetición detenida. No se ejecutó la herramienta en producción desde este equipo.
