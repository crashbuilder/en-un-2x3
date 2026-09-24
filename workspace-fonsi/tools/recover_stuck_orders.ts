import { Client } from 'pg';

/**
 * Busca pedidos retrasados o "perdidos" (más de 45 minutos sin entregar) 
 * y los vuelve a poner 'activos' (CONFIRMED) para reasignar otra moto.
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
    // Buscar órdenes que no estén entregadas ni canceladas
    // y que tengan más de 45 minutos de creadas.
    const res = await client.query(`
      SELECT id, code, status, courier_id, created_at 
      FROM orders 
      WHERE status NOT IN ('DELIVERED', 'CANCELLED', 'DRAFT')
      AND created_at < NOW() - INTERVAL '45 minutes'
    `);

    const stuckOrders = res.rows;
    const recovered = [];

    for (const order of stuckOrders) {
      // Ponerlo activo nuevamente: quitamos el mensajero anterior si lo tenía 
      // y lo devolvemos a CONFIRMED para que el sistema de despacho lo vuelva a tomar
      await client.query(`
        UPDATE orders 
        SET status = 'CONFIRMED', courier_id = NULL 
        WHERE id = $1
      `, [order.id]);

      recovered.push(order.code);
    }

    return {
      status: 'success',
      message: recovered.length > 0 
        ? `Se encontraron ${recovered.length} pedidos retrasados/perdidos y se volvieron a activar para reasignación.` 
        : 'Todos los pedidos están en tiempo óptimo. No hay pedidos perdidos.',
      recovered_orders: recovered
    };
  } catch (err: any) {
    return { status: 'error', error: err.message };
  } finally {
    await client.end();
  }
}
