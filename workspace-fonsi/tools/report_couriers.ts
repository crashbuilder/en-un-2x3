import { Client } from 'pg';

/**
 * Genera el reporte de cuánto hizo cada moto (mensajero) en el día.
 * Útil para el Dashboard Administrativo.
 */
export async function report_couriers(dateStr?: string) {
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'fonsi_user',
    password: process.env.DB_PASSWORD || 'fonsi_password',
    database: process.env.DB_NAME || 'en_un_2x3'
  });

  await client.connect();

  try {
    const dateQuery = dateStr || new Date().toISOString().split('T')[0];

    // Consultamos la tabla settlements, o calculamos dinámicamente si no se ha corrido el cierre
    const res = await client.query(`
      SELECT 
        c.name as courier_name,
        c.vehicle,
        c.wa_phone,
        COUNT(o.id) as total_services,
        COALESCE(SUM(o.delivery_fee), 0) as fees_earned,
        COALESCE(SUM(CASE WHEN o.payment_method IN ('cash', 'mixed') THEN o.total ELSE 0 END), 0) as cash_collected,
        COALESCE(SUM(CASE WHEN o.payment_method IN ('cash', 'mixed') THEN o.total ELSE 0 END), 0) - COALESCE(SUM(o.delivery_fee), 0) as owed_to_company
      FROM couriers c
      LEFT JOIN orders o ON o.courier_id = c.id AND o.status = 'DELIVERED' AND o.created_at::date = $1::date
      GROUP BY c.id, c.name, c.vehicle, c.wa_phone
      ORDER BY fees_earned DESC;
    `, [dateQuery]);

    return {
      status: 'success',
      date: dateQuery,
      couriers_report: res.rows.map(row => ({
        name: row.courier_name,
        phone: row.wa_phone,
        vehicle: row.vehicle,
        services_completed: parseInt(row.total_services),
        earnings: parseInt(row.fees_earned),
        cash_in_pockets: parseInt(row.cash_collected),
        must_consign_to_company: parseInt(row.owed_to_company)
      }))
    };
  } catch (err: any) {
    return { status: 'error', error: err.message };
  } finally {
    await client.end();
  }
}
