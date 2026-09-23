import { Client } from 'pg';

/**
 * Cronjob (Ej: Jueves en la mañana) para monitorear la carta fija de los restaurantes Gourmet/A la carta.
 */
export async function gourmet_catalog_check() {
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'fonsi_user',
    password: process.env.DB_PASSWORD || 'fonsi_password',
    database: process.env.DB_NAME || 'en_un_2x3'
  });

  await client.connect();

  try {
    // Buscar restaurantes que NO son de corrientazo (Restaurantes a la carta/Gourmet/Comida rápida)
    const res = await client.query(`
      SELECT name FROM merchants 
      WHERE NOT ('corriente' = ANY(category)) AND NOT ('comida tipica' = ANY(category))
    `);
    
    const merchants = res.rows;

    if (merchants.length === 0) {
       return { status: 'success', message: 'No hay comercios a la carta para consultar hoy.' };
    }

    const messageTemplate = "¡Hola Chef! 👨‍🍳 Preparando todo para las ventas de estos días... Revisando su PDF/Carta fija, ¿todo está disponible o apagamos algún plato temporalmente por falta de algún ingrediente o fin de temporada?";

    console.log(`[Gourmet_Check] Consultando disponibilidad de carta completa a ${merchants.length} restaurantes...`);

    return {
      status: 'success',
      action: 'send_gourmet_catalog_check',
      merchants_contacted: merchants.map(m => m.name),
      template_used: messageTemplate
    };
  } catch (err: any) {
    return { status: 'error', error: err.message };
  } finally {
    await client.end();
  }
}
