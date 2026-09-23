import { Client } from 'pg';

/**
 * Cronjob (7:30 a.m.) para pedirle a los restaurantes su menú del día.
 */
export async function merchant_ping() {
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'fonsi_user',
    password: process.env.DB_PASSWORD || 'fonsi_password',
    database: process.env.DB_NAME || 'en_un_2x3'
  });

  await client.connect();

  try {
    // Buscar todos los comercios activos (que ofrezcan comidas corrientes)
    const res = await client.query("SELECT id, name FROM merchants WHERE 'corriente' = ANY(category) OR 'comida tipica' = ANY(category)");
    const merchants = res.rows;

    if (merchants.length === 0) {
       return { status: 'success', message: 'No hay aliados de menú diario para notificar.' };
    }

    // Aquí OpenClaw dispararía el mensaje de Telegram/WhatsApp a cada comercio
    const messageTemplate = "¡Buenos días ☀️! Soy Fonsi 🛵. ¿Qué tenemos hoy de menú del día? Mándame una foto de la cartelera o escríbelo por aquí para subirlo a la plataforma en un 2x3.";

    console.log(`[Merchant_Ping] Notificando a ${merchants.length} restaurantes para pedir su menú...`);

    return {
      status: 'success',
      action: 'send_messages_to_merchants',
      merchants_contacted: merchants.map(m => m.name),
      template_used: messageTemplate
    };
  } catch (err: any) {
    return { status: 'error', error: err.message };
  } finally {
    await client.end();
  }
}
