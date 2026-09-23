import { Client } from 'pg';

/**
 * Asigna un mensajero a una orden específica (Fase 1: Asignación manual/simulada).
 */
export async function dispatch_assign(orderId: string, courierId: string) {
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'fonsi_user',
    password: process.env.DB_PASSWORD || 'fonsi_password',
    database: process.env.DB_NAME || 'en_un_2x3'
  });

  await client.connect();

  try {
    const res = await client.query(`
      UPDATE orders 
      SET courier_id = $1, status = 'ON_THE_WAY' 
      WHERE id = $2 OR code = $2
      RETURNING id, code, status
    `, [courierId, orderId]);

    if (res.rowCount === 0) {
       return { status: 'error', error: 'Order not found' };
    }

    return {
      status: 'success',
      order: res.rows[0],
      message: 'Mensajero asignado exitosamente.',
      map_ui_payload: {
        // Esto lo leerá la futura App del mensajero para trazar la ruta de 3 puntos
        instruction: 'Draw 3-point route: [Courier_Current_Location] -> [Origin_Merchant] -> [Destination_Customer]',
        google_maps_link: `https://www.google.com/maps/dir/?api=1&origin=Current+Location&destination=[DESTINATION_COORDS]&waypoints=[MERCHANT_COORDS]`
      }
    };
  } catch (err: any) {
    return { status: 'error', error: err.message };
  } finally {
    await client.end();
  }
}
