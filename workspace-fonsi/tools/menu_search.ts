import { Client } from 'pg';

/**
 * Busca comercios por antojo (categoría o nombre).
 * @param query Texto de búsqueda, ej. "pollo", "hamburguesa"
 */
export async function menu_search(query: string) {
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'fonsi_user',
    password: process.env.DB_PASSWORD || 'fonsi_password',
    database: process.env.DB_NAME || 'en_un_2x3'
  });

  await client.connect();

  try {
    const res = await client.query(`
      SELECT name, specialty, menu, sponsored 
      FROM merchants 
      WHERE 
        $1 = ANY(category) 
        OR name ILIKE $2
      ORDER BY sponsored DESC
    `, [query.toLowerCase(), `%${query}%`]);

    return {
      status: 'success',
      results: res.rows
    };
  } catch (err: any) {
    return { status: 'error', error: err.message };
  } finally {
    await client.end();
  }
}
