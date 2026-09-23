import { Client } from 'pg';

/**
 * Consulta el estado actual de una orden y simula el tracking.
 * @param orderId ID de la orden o código FX-XXXX
 */
export async function tracking_poll(orderId: string) {
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'fonsi_user',
    password: process.env.DB_PASSWORD || 'fonsi_password',
    database: process.env.DB_NAME || 'en_un_2x3'
  });

  await client.connect();

  try {
    const isCode = orderId.startsWith('FX-');
    const query = isCode 
      ? 'SELECT id, code, status, eta_minutes FROM orders WHERE code = $1'
      : 'SELECT id, code, status, eta_minutes FROM orders WHERE id = $1';

    const res = await client.query(query, [orderId]);

    if (res.rows.length === 0) {
      return { status: 'error', error: 'Order not found' };
    }

    const order = res.rows[0];

    // Para la fase 1, retornamos el estado y un ETA simulado.
    return {
      status: 'success',
      tracking: {
        code: order.code,
        current_status: order.status,
        message: getStatusMessage(order.status),
        eta_minutes: order.eta_minutes || 'Calculando...'
      }
    };
  } catch (err: any) {
    return { status: 'error', error: err.message };
  } finally {
    await client.end();
  }
}

function getStatusMessage(status: string) {
  const map: Record<string, string> = {
    'DRAFT': 'Pendiente de confirmación o pago',
    'CONFIRMED': 'Recibido por el comercio',
    'PREPARING': 'En preparación',
    'PICKED_UP': 'Recogido por el mensajero',
    'ON_THE_WAY': 'En camino a tu ubicación',
    'DELIVERED': 'Entregado',
    'CANCELLED': 'Cancelado'
  };
  return map[status] || status;
}
