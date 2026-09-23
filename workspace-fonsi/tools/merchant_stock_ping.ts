import { Client } from 'pg';

/**
 * Cronjob (Ej: 1:00 p.m. y 7:00 p.m.) para monitorear el inventario en horas pico.
 */
export async function merchant_stock_ping() {
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'fonsi_user',
    password: process.env.DB_PASSWORD || 'fonsi_password',
    database: process.env.DB_NAME || 'en_un_2x3'
  });

  await client.connect();

  try {
    // Buscar comercios que tienen platos diarios activos hoy
    const res = await client.query(`
      SELECT name FROM merchants, jsonb_array_elements(menu) AS m
      WHERE (m->>'type' = 'diario' AND m->>'available' = 'true')
      GROUP BY name
    `);
    
    const merchants = res.rows;

    if (merchants.length === 0) {
       return { status: 'success', message: 'No hay comercios con menú diario activo para monitorear.' };
    }

    const messageTemplate = "¡Hola! 🛵 Pasando la hora pico... ¿Todavía le queda de todos los platos que publicamos hoy o ya apagamos alguno en la plataforma para que no pidan lo que no hay?";

    console.log(`[Stock_Ping] Consultando disponibilidad a ${merchants.length} restaurantes...`);

    return {
      status: 'success',
      action: 'send_stock_check_messages',
      merchants_contacted: merchants.map(m => m.name),
      template_used: messageTemplate
    };
  } catch (err: any) {
    return { status: 'error', error: err.message };
  } finally {
    await client.end();
  }
}
