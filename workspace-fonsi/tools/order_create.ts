import { Client } from 'pg';

export interface OrderInput {
  userId: string;
  merchantId?: string;
  type: 'food' | 'package' | 'ride';
  items: any[];
  subtotal: number;
  deliveryFee: number;
  paymentMethod: 'cash' | 'transfer' | 'mixed';
  origin?: any;
  destination?: any;
}

/**
 * Crea una nueva orden en el sistema.
 */
export async function order_create(input: OrderInput) {
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'fonsi_user',
    password: process.env.DB_PASSWORD || 'fonsi_password',
    database: process.env.DB_NAME || 'en_un_2x3'
  });

  await client.connect();

  try {
    // Generar código de 4 dígitos aleatorio
    const randomCode = Math.floor(1000 + Math.random() * 9000);
    const code = `FX-${randomCode}`;
    const total = input.subtotal + input.deliveryFee;

    // Si es efectivo, pasa directo a CONFIRMED. Si es transferencia, queda en DRAFT hasta pago.
    const initialStatus = input.paymentMethod === 'cash' ? 'CONFIRMED' : 'DRAFT';

    const res = await client.query(`
      INSERT INTO orders (
        code, type, user_id, merchant_id, status, items, 
        subtotal, delivery_fee, total, payment_method, payment_status,
        origin, destination
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PENDING', $11, $12
      ) RETURNING id, code, status
    `, [
      code, input.type, input.userId, input.merchantId, initialStatus, 
      JSON.stringify(input.items), input.subtotal, input.deliveryFee, 
      total, input.paymentMethod, input.origin, input.destination
    ]);

    return {
      status: 'success',
      order: res.rows[0]
    };
  } catch (err: any) {
    return { status: 'error', error: err.message };
  } finally {
    await client.end();
  }
}
