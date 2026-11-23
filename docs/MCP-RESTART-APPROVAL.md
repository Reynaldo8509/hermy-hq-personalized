# Solicitudes de reinicio MCP

## Estado y alcance

Este documento describe el código fuente público, no una garantía sobre el runtime. En la inspección de solo lectura del 23 de noviembre de 2026, el selector productivo de Hermy HQ apuntaba al release `mcp-restart-approval-20261122-r3`; ese release no acreditaba la ruta dinámica de consulta. La implementación de `main` publicada aquí es una corrección de código aislada y no se desplegó ni se probó contra la base de datos productiva. Estado: `IMPLEMENTED_NOT_E2E_VERIFIED` para el snapshot; producción: `NOT_VERIFIED`.

Un HTTP 404 puede significar que el identificador no existe o no pertenece a la identidad MCP. También puede significar que el build activo no registró la ruta dinámica; solo una petición al runtime desplegado permite distinguirlo. La presencia de un archivo o manifiesto de build no prueba por sí sola el contrato HTTP productivo.

## Contrato

| Operación | Ruta | Efecto |
|---|---|---|
| Crear solicitud | `POST /api/mcp/restart-requests` | Registra una aprobación pendiente para la unidad allowlisted. No reinicia nada. |
| Consultar estado | `GET /api/mcp/restart-requests/{id}` | Devuelve el estado de la solicitud propia; no modifica la fila. |

La solicitud acepta únicamente JSON con las propiedades exactas `operation: "restart"` y `unit: "rey-infrastructure-mcp-admin.service"`. El cuerpo tiene un límite de 2 KiB. Otras operaciones, unidades, métodos, rutas, query strings y fragments se rechazan.

La identidad se autentica con el header `x-mcp-restart-token`, comparado en tiempo constante contra la credencial del servicio cargada mediante `CREDENTIALS_DIRECTORY`. La lectura requiere directorio y archivo propiedad del usuario del proceso, sin permisos de grupo/otros ni enlaces simbólicos o hardlinks. El token no forma parte de la documentación ni de un archivo de ejemplo.

## Aprobación humana y persistencia

- Las solicitudes se guardan en la tabla existente `ActionApproval`; no necesitan una migración Prisma.
- Una transacción usa un advisory lock para impedir solicitudes pendientes duplicadas. Hay un máximo de una pendiente para la unidad configurada y un límite de tres solicitudes por hora.
- La expiración es de 30 minutos. La API de estado solo presenta `APPROVED` cuando la fila está aprobada por una identidad humana no sistémica.
- Action Center y la API humana de aprobaciones eliminan el nonce de reintento antes de devolver datos. El nonce se conserva en la fila para recuperar un POST de resultado incierto y solo se entrega al cliente con la identidad de servicio.
- El operador debe revisar y aprobar desde Action Center. El agente MCP no puede aprobar, rechazar ni ejecutar el reinicio mediante estas rutas.

## Validación y límites

Las pruebas unitarias cubren el parser, el esquema, deduplicación, límites, expiración, identidad, rechazo de rutas y redacción del nonce. El CI del PR instala el lockfile existente, aplica las migraciones solo a un PostgreSQL efímero, construye la aplicación, verifica el manifiesto de Next.js y ejecuta el harness HTTP con una credencial sintética temporal. El harness se niega a continuar si las URL no apuntan a `localhost` y los puertos de prueba fijados.

Estos controles no sustituyen la prueba HTTP contra el runtime instalado ni prueban el controlador de reinicio. No se ejecutan inferencias, no se llama al servicio de reinicio y no se realizaron cambios en producción como parte de esta sincronización.
