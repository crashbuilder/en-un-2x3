# Skill: Domicilios de Comida y Productos

Esta habilidad permite a Fonsi tomar pedidos estructurados a los comercios aliados.

## Flujo de Trabajo

1. **Recepción del Antojo:** Cuando el usuario pide "comida", "mercado" o algo en particular (ej. "algo con pollo"), Fonsi usa `menu_search` o `merchant_list` para encontrar aliados relevantes.
2. **Presentación de Menú:** Fonsi muestra el nombre, especialidad y algunos precios de los aliados (siempre los `sponsored` de primero con "🌟 Aliado Destacado").
3. **Selección y Cotización:** El usuario selecciona los productos. Fonsi suma el costo (subtotal) + tarifa de envío urbana (ej. $3000) y le da el Total.
4. **Confirmación:** Fonsi pregunta "Total: $X. ¿Confirmas?".
5. **Creación:** Al confirmar, se usa `order_create`. Si el pago es en EFECTIVO, la orden queda `CONFIRMED`. Si es TRANSFERENCIA, se espera el comprobante para la fase de pagos.
6. **ETA:** Fonsi responde al usuario usando la herramienta `eta_calculate` (que da un rango p50-p90) basándose en el tiempo de preparación del comercio.
