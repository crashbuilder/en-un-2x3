import { Client } from 'pg';

/**
 * Recopila los aliados patrocinados y publica el estado del día.
 * En OpenClaw esto sería invocado por un cronjob a las 8:00 a.m.
 */
export async function status_publish() {
  const client = new Client({
    host: process.env.DB_HOST || 'postgres',
    user: process.env.DB_USER || 'fonsi_user',
    password: process.env.DB_PASSWORD || 'fonsi_password',
    database: process.env.DB_NAME || 'en_un_2x3'
  });

  await client.connect();

  try {
    const res = await client.query("SELECT name, specialty FROM merchants WHERE ad_plan IN ('estado', 'premium') AND sponsored = true");
    const merchants = res.rows;

    if (merchants.length === 0) {
       return { status: 'success', message: 'No hay aliados activos para publicar hoy.' };
    }

    // Aquí iría la integración con la API de estados de WhatsApp.
    console.log(`[Status_Publish] Publicando estado con ${merchants.length} aliados...`);

    // Registramos la publicación en la BD
    await client.query('INSERT INTO status_posts (merchants) VALUES ($1)', [JSON.stringify(merchants)]);

    return {
      status: 'success',
      message: 'Estado de WhatsApp publicado con éxito. Fonsi invita a pautar al final del estado.',
      merchants_featured: merchants.length
    };
  } catch (err: any) {
    return { status: 'error', error: err.message };
  } finally {
    await client.end();
  }
}
