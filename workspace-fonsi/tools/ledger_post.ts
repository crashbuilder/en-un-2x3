import { Client } from 'pg';

/**
 * Registra los movimientos contables de una orden (Doble entrada simplificada).
 * Garantiza que SUM(debit) == SUM(credit).
 */
export async function ledger_post(orderId: string) {
  const client = new Client({
    host: process.env.DB_HOST || 'postgres',
    user: process.env.DB_USER || 'fonsi_user',
    password: process.env.DB_PASSWORD || 'fonsi_password',
    database: process.env.DB_NAME || 'en_un_2x3'
  });

  await client.connect();

  try {
    const res = await client.query('SELECT * FROM orders WHERE id::text = $1 OR code = $1', [orderId]);
    if (res.rows.length === 0) return { status: 'error', error: 'Order not found' };
    
    const order = res.rows[0];
    const subtotal = Number(order.subtotal);
    const deliveryFee = Number(order.delivery_fee);
    const total = Number(order.total);
    
    const commissionPct = 0.12; // 12%
    const comission = Math.round(subtotal * commissionPct);
    const merchantPayout = subtotal - comission;
    
    const courierId = order.courier_id || 'unassigned';
    const merchantId = order.merchant_id || 'general';

    await client.query('BEGIN');

    // 1. Limpiar asientos previos de esta orden si ya existían (idempotencia)
    await client.query('DELETE FROM ledger WHERE order_id = $1', [order.id]);

    if (order.payment_method === 'cash') {
      // Cliente paga todo en efectivo al mensajero
      await client.query(
        'INSERT INTO ledger (order_id, account, debit, credit, memo) VALUES ($1, $2, $3, 0, $4)',
        [order.id, `caja_mensajero:${courierId}`, total, 'Efectivo recibido por mensajero']
      );
      await client.query(
        'INSERT INTO ledger (order_id, account, debit, credit, memo) VALUES ($1, $2, 0, $3, $4)',
        [order.id, `cxc_comercio:${merchantId}`, merchantPayout, 'Por pagar al comercio']
      );
      await client.query(
        'INSERT INTO ledger (order_id, account, debit, credit, memo) VALUES ($1, $2, 0, $3, $4)',
        [order.id, 'ingreso_comision', comission, 'Comisión 12% empresa']
      );
      await client.query(
        'INSERT INTO ledger (order_id, account, debit, credit, memo) VALUES ($1, $2, 0, $3, $4)',
        [order.id, 'ingreso_domicilio', deliveryFee, 'Tarifa de domicilio (100% mensajero)']
      );
    } else if (order.payment_method === 'transfer') {
      // Cliente transfiere todo a la cuenta de la empresa
      await client.query(
        'INSERT INTO ledger (order_id, account, debit, credit, memo) VALUES ($1, $2, $3, 0, $4)',
        [order.id, 'banco_empresa', total, 'Transferencia bancaria recibida']
      );
      await client.query(
        'INSERT INTO ledger (order_id, account, debit, credit, memo) VALUES ($1, $2, 0, $3, $4)',
        [order.id, `cxc_comercio:${merchantId}`, merchantPayout, 'Por pagar al comercio']
      );
      await client.query(
        'INSERT INTO ledger (order_id, account, debit, credit, memo) VALUES ($1, $2, 0, $3, $4)',
        [order.id, 'ingreso_comision', comission, 'Comisión 12% empresa']
      );
      await client.query(
        'INSERT INTO ledger (order_id, account, debit, credit, memo) VALUES ($1, $2, 0, $3, $4)',
        [order.id, `cxp_mensajero:${courierId}`, deliveryFee, 'Tarifa de domicilio adeudada al mensajero']
      );
    } else {
      // Escenario Mixto: Producto por transferencia, envío en efectivo
      const transferPart = Number(order.transfer_part) || subtotal;
      const cashPart = Number(order.cash_part) || deliveryFee;

      await client.query(
        'INSERT INTO ledger (order_id, account, debit, credit, memo) VALUES ($1, $2, $3, 0, $4)',
        [order.id, 'banco_empresa', transferPart, 'Transferencia bancaria (producto)']
      );
      await client.query(
        'INSERT INTO ledger (order_id, account, debit, credit, memo) VALUES ($1, $2, $3, 0, $4)',
        [order.id, `caja_mensajero:${courierId}`, cashPart, 'Efectivo recibido (domicilio)']
      );
      await client.query(
        'INSERT INTO ledger (order_id, account, debit, credit, memo) VALUES ($1, $2, 0, $3, $4)',
        [order.id, `cxc_comercio:${merchantId}`, merchantPayout, 'Por pagar al comercio']
      );
      await client.query(
        'INSERT INTO ledger (order_id, account, debit, credit, memo) VALUES ($1, $2, 0, $3, $4)',
        [order.id, 'ingreso_comision', comission, 'Comisión 12% empresa']
      );
      await client.query(
        'INSERT INTO ledger (order_id, account, debit, credit, memo) VALUES ($1, $2, 0, $3, $4)',
        [order.id, 'ingreso_domicilio', deliveryFee, 'Tarifa de domicilio']
      );
    }

    // Verificar balance exacto del asiento
    const balanceRes = await client.query(
      'SELECT SUM(debit) as total_debit, SUM(credit) as total_credit FROM ledger WHERE order_id = $1',
      [order.id]
    );
    const { total_debit, total_credit } = balanceRes.rows[0];

    if (Number(total_debit) !== Number(total_credit)) {
      throw new Error(`Asiento contable descuadrado: Débito ${total_debit} != Crédito ${total_credit}`);
    }

    await client.query('COMMIT');
    return {
      status: 'success',
      order_id: order.id,
      code: order.code,
      total_debit: Number(total_debit),
      total_credit: Number(total_credit),
      balanced: true,
      message: 'Asiento contable registrado y balanceado con éxito.'
    };
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('Error en ledger_post:', err);
    return { status: 'error', error: err.message };
  } finally {
    await client.end();
  }
}

