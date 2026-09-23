import { Client } from 'pg';
import { courier_settle } from './courier_settle';

/**
 * Cierre de caja diario. En OpenClaw corre a las 10:00 p.m.
 */
export async function report_daily() {
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'fonsi_user',
    password: process.env.DB_PASSWORD || 'fonsi_password',
    database: process.env.DB_NAME || 'en_un_2x3'
  });

  await client.connect();

  try {
    const today = new Date().toISOString().split('T')[0];
    
    // 1. Obtener mensajeros activos y liquidarlos
    const couriers = await client.query("SELECT id FROM couriers WHERE is_active = true");
    for (const c of couriers.rows) {
      await courier_settle(c.id, today);
    }

    // 2. Generar resumen global
    const res = await client.query(`
      SELECT 
        COUNT(id) as total_orders,
        SUM(total) as revenue,
        SUM(delivery_fee) as courier_payouts
      FROM orders 
      WHERE status = 'DELIVERED' AND created_at::date = $1::date
    `, [today]);

    const report = res.rows[0];

    // Simula envío por WhatsApp al dueño
    console.log(`[Cierre Diario - ${today}] Ventas: ${report.revenue} | Órdenes: ${report.total_orders}`);

    return {
      status: 'success',
      report: {
        date: today,
        total_orders: parseInt(report.total_orders || '0'),
        gross_revenue: parseInt(report.revenue || '0'),
        courier_payouts: parseInt(report.courier_payouts || '0')
      }
    };
  } catch (err: any) {
    return { status: 'error', error: err.message };
  } finally {
    await client.end();
  }
}
