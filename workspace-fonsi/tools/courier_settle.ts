import { Client } from 'pg';

/**
 * Liquida a un mensajero: Efectivo recaudado vs Tarifas ganadas.
 */
export async function courier_settle(courierId: string, dateStr: string) {
  const client = new Client({
    host: process.env.DB_HOST || 'postgres',
    user: process.env.DB_USER || 'fonsi_user',
    password: process.env.DB_PASSWORD || 'fonsi_password',
    database: process.env.DB_NAME || 'en_un_2x3'
  });

  await client.connect();

  try {
    // Buscar órdenes DELIVERED de ese día por ese mensajero
    const res = await client.query(`
      SELECT total, delivery_fee, payment_method, cash_part 
      FROM orders 
      WHERE courier_id = $1 AND status = 'DELIVERED' 
      AND created_at::date = $2::date
    `, [courierId, dateStr]);

    const orders = res.rows;
    
    // Sumar el efectivo total que el mensajero recibió físicamente
    let cashCollected = 0;
    // Sumar los domicilios que el mensajero se ganó (100% para él según regla)
    let feesEarned = 0;

    orders.forEach(o => {
      feesEarned += o.delivery_fee;
      if (o.payment_method === 'cash') {
        cashCollected += o.total;
      } else if (o.payment_method === 'mixed') {
        cashCollected += o.cash_part;
      }
    });

    const owedToCompany = cashCollected - feesEarned;
    const net = owedToCompany;

    await client.query(`
      INSERT INTO settlements (courier_id, date, cash_collected, fees_earned, owed_to_company, net)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (courier_id, date) DO UPDATE 
      SET cash_collected = $3, fees_earned = $4, owed_to_company = $5, net = $6
    `, [courierId, dateStr, cashCollected, feesEarned, owedToCompany, net]);

    return {
      status: 'success',
      settlement: {
        services: orders.length,
        cash_collected: cashCollected,
        fees_earned: feesEarned,
        net_to_consign: Math.max(net, 0)
      }
    };
  } catch (err: any) {
    return { status: 'error', error: err.message };
  } finally {
    await client.end();
  }
}
