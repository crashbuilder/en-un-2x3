import { Client } from 'pg';

/**
 * Watchdog inteligente para pedidos retrasados / atascados:
 * 1. Pedidos > 12 horas en estado no finalizado se cancelan automáticamente (evita bucles infinitos).
 * 2. Pedidos entre 45 min y 12 horas se reactivan a 'CONFIRMED' para reasignación de conductor.
 */
export async function recover_stuck_orders() {
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'fonsi_user',
    password: process.env.DB_PASSWORD || 'fonsi_password',
    database: process.env.DB_NAME || 'en_un_2x3'
  });

  await client.connect();

  try {
    // 1. Auto-cancelar pedidos abandonados (> 12 horas)
    const expiredRes = await client.query(`
      UPDATE orders 
      SET status = 'CANCELLED' 
      WHERE status NOT IN ('DELIVERED', 'CANCELLED', 'DRAFT')
      AND created_at < NOW() - INTERVAL '12 hours'
      RETURNING code
    `);
    const expiredCodes = expiredRes.rows.map(r => r.code);

    // 2. Reactivar pedidos atascados recientes (entre 45 min y 12 horas)
    const stuckRes = await client.query(`
      SELECT id, code, status, courier_id, created_at 
      FROM orders 
      WHERE status NOT IN ('DELIVERED', 'CANCELLED', 'DRAFT')
      AND created_at >= NOW() - INTERVAL '12 hours'
      AND created_at < NOW() - INTERVAL '45 minutes'
    `);

    const recovered: string[] = [];
    for (const order of stuckRes.rows) {
      await client.query(`
        UPDATE orders 
        SET status = 'CONFIRMED', courier_id = NULL 
        WHERE id = $1
      `, [order.id]);
      recovered.push(order.code);
    }

    return {
      status: 'success',
      expired_count: expiredCodes.length,
      expired_orders: expiredCodes,
      recovered_count: recovered.length,
      recovered_orders: recovered,
      message: `Auto-cancelados: ${expiredCodes.length} (>12h) | Reactivados: ${recovered.length} (45m-12h)`
    };
  } catch (err: any) {
    return { status: 'error', error: err.message };
  } finally {
    await client.end();
  }
}
