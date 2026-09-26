# Arquitectura y controles

El frontend Next.js consulta las API internas de Hermy HQ. El puente `hermes-bridge/bridge.mjs` lee solicitudes persistidas, consulta estados, asigna el tipo de tarea y ejecuta Hermes o sus workers. PostgreSQL almacena solicitudes/aprobaciones/estado en producción; no se incluye aquí.

## Jerarquía lógica

- **Usuario**: inicia tareas y decide las aprobaciones pendientes.
- **MAX**: coordinación principal y descomposición/delegación de tareas.
- **Especialistas**: ATLAS, CODEX, AEGIS, MILO, PULSE, LEDGER y DOMUS reciben categorías específicas.
- **Puente**: encola, filtra agentes pausados, despacha y registra los resultados.
- **Hermy HQ**: interfaz de actividad, historial, controles y aprobaciones.

Las tareas programadas pasan por la comprobación de pausa antes de crear una nueva solicitud. El worker vuelve a comprobar el estado antes de ejecutar; por ello, la pausa impide tanto nuevo encolado de supervisión como el despacho de solicitudes del agente.

## Botones de control

- **Pause / Resume** cambia el estado persistido del agente. La interfaz muestra el estado y evita despachar solicitudes dirigidas a un agente pausado.
- **Stop agent** cancela solicitudes activas de las categorías del agente y termina el worker correspondiente cuando hay un PID registrado.
- **Emergency reset** cierra trabajo activo para todos los agentes y termina los workers registrados. Se conserva el historial para auditoría.

## Aprobaciones

La API lista aprobaciones pendientes y las operaciones de decisión actualizan estado, autor y hora de resolución. Las aprobaciones vencidas se marcan como expiradas; las solicitudes enlazadas se rechazan con ese resultado. Los valores/solicitudes reales viven en la base privada y no están en el repo.

## Rutas de referencia

- `src/app/agents/page.tsx`: panel y controles visibles.
- `src/app/api/agents/control/route.ts`: cancelación por agente y emergencia global.
- `src/app/api/hermes/approvals/route.ts`: lectura y decisión de aprobaciones.
- `hermes-bridge/bridge.mjs`: cola, pausa y despacho del puente.
- `prisma/schema.prisma`: esquema de datos, sin datos.

## Límites de la publicación

El diagrama y esta guía documentan el código fuente activo en el commit publicado. La base productiva y su historial, conversaciones, secretos y ajustes específicos del VPS están excluidos.
