# URL de conexión y relay Home Assistant

En Ajustes → General, la URL de conexión pública se guarda en PostgreSQL y puede
editarse sin reiniciar. Se utiliza para los webhooks predeterminados de Telegram,
el retorno OAuth de Google y los callbacks de reglas de nuevas vinculaciones.
Si está vacía, se utiliza `ASSISTANT_ADMIN_URL` hasta que la integración anuncie
un relay HTTPS. Una dirección guardada por el usuario nunca se sobrescribe.
Se admiten prefijos de ruta, por ejemplo
`https://ha.example/api/assistant_zero/relay/ENTRY_ID`.

Cambiarla no registra webhooks externos ni modifica los ya guardados. Revisa la
URL y registra el webhook de cada asistente cuando cambies de dominio. Para
Google, registra el URI de retorno que muestra el perfil en la consola de Google.
Los intentos OAuth en curso conservan su URI de retorno original.

En Ajustes → Home Assistant se muestran los accesos de la integración, con
paginación. Se pueden editar nombre y caducidad o revocar con confirmación.
Revocar no borra reglas, perfiles ni memorias; para recuperar la conexión hay que
vincular de nuevo. Los vínculos de voz se editan desde su perfil y se pueden
desvincular por separado.

## Relay de assistant_zero 1.7.0

La integración registra `/api/assistant_zero/relay/ENTRY_ID/...` y anuncia su URL
si Home Assistant dispone de una dirección externa HTTPS (incluido el acceso
remoto de Home Assistant Cloud). Zero la adopta únicamente si su URL está vacía.
No se anuncian direcciones HTTP o exclusivamente internas. Un cloudhook aislado
no equivale a un origen HTTPS con estas rutas; se necesita acceso externo a Home
Assistant, pero Zero puede permanecer en la red privada.

Se admiten exclusivamente:

- POST `/telegram/assistants/ID/webhook`: conserva el cuerpo y el secreto de Telegram.
- POST `/v1/triggers/rule-events`: conserva el cuerpo y el bearer del callback.
- GET `/v1/admin/google/oauth/callback`: redirige el navegador al origen del
  administrador de Zero con `state`, `code` y `error`; no reenvía cookies ni expone
  el administrador a través de Home Assistant. El navegador debe poder acceder a
  esa dirección de Zero. La cookie original y el estado de un solo uso siguen
  siendo necesarios.

Antes de cada entrega se valida con Zero el acceso de la integración. Revocarlo
bloquea el relay. Descargar/eliminar la integración retira su destino. Los cuerpos
se limitan a 1 MB y los envíos tienen timeout; no hay reintentos, redirecciones
HTTP ascendentes, destinos arbitrarios, cookies reenviadas ni respuestas privadas
del proveedor. Zero sigue validando el secreto de Telegram y el bearer de reglas.

Si cambia el dominio externo de Home Assistant, revisa la URL en Zero y actualiza
los webhooks registrados. El relay no modifica configuraciones ya guardadas ni
reproduce trabajos interrumpidos. Si el anuncio falla, se informa en el log de
Home Assistant y se puede configurar la URL manualmente; no se reintenta la
mutación incierta.

Este cambio no instala ni actualiza la integración en el Home Assistant en vivo.

Referencias oficiales:

- https://www.home-assistant.io/docs/automation/trigger/#webhook-trigger
- https://contributors.home-assistant.io/security/guides/integrations/#webhooks
