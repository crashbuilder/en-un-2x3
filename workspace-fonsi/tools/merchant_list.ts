import { Client } from 'pg';

/**
 * Retorna la lista de comercios ordenando los 'sponsored' primero.
 */
export async function merchant_list() {
  const client = new Client({
    host: process.env.DB_HOST || 'postgres',
    user: process.env.DB_USER || 'fonsi_user',
    password: process.env.DB_PASSWORD || 'fonsi_password',
    database: process.env.DB_NAME || 'en_un_2x3'
  });

  await client.connect();

  try {
    const res = await client.query(`
      SELECT id, name, specialty, menu, sponsored 
      FROM merchants 
      ORDER BY sponsored DESC, name ASC
    `);

    return {
      status: 'success',
      merchants: res.rows
    };
  } catch (err: any) {
    return { status: 'error', error: err.message };
  } finally {
    await client.end();
  }
}
