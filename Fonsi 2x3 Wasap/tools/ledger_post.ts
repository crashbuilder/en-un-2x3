import { Client } from 'pg';

/**
 * Registra los asientos contables de una orden bajo estricta Partida Doble.
 * 
 * Reglas de negocio oficiales:
 * 1. Restaurantes/Comercios: 0% comisión (100% del subtotal va al restaurante).
 * 2. Domicilios urbanos:
 *    - 1 parada ($3.000): $2.000 mensajero, $1.000 Fonsi
 *    - 2 paradas ($5.000): $3.500 mensajero, $1.500 Fonsi
 *    - 3 paradas ($8.000): $6.000 mensajero, $2.000 Fonsi
 * 3. Mototaxi urbano: 100% de la tarifa ($3.000 o $4.000) va al mototaxista.
 *    (La empresa cobra la suscripción de $2.000/día en la liquidación diaria).
 * 4. Rutas intermunicipales en carro:
 *    - Comisión Fonsi: $4.000 por pasajero.
 *    - El resto va al conductor.
 */
export async function ledger_post(orderId: string) {
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'fonsi_user',
    password: process.env.DB_PASSWORD || 'fonsi_password',
    database: process.env.DB_NAME || 'en_un_2x3'
  });

  await client.connect();

  try {
    const res = await client.query('SELECT * FROM orders WHERE id::text = $1 OR code = $1', [orderId]);
    if (res.rows.length === 0) return { status: 'error', error: 'Order not found' };
    
    const order = res.rows[0];
    const subtotal = Number(order.subtotal) || 0;
    const deliveryFee = Number(order.delivery_fee) || 0;
    const total = Number(order.total) || (subtotal + deliveryFee);
    const orderType = order.type || 'food';
    const isRide = orderType === 'ride';
    const courierId = order.courier_id || 'unassigned';
    const merchantId = order.merchant_id || 'general';

    // Determinar si es intermunicipal (por el destino o tipo de viaje)
    const destStr = typeof order.destination === 'string' 
      ? order.destination 
      : (order.destination?.label || '');
    const isIntermunicipal = /distraccion|barrancas|san juan|molino|hatonuevo|villanueva|urumita|maicao|riohacha/i.test(destStr);

    let platformFee = 0;
    let courierEarnings = 0;
    let merchantPayout = subtotal; // 0% comisión a restaurantes (100% para ellos)

    if (isRide) {
      if (isIntermunicipal) {
        // Intermunicipal: Fonsi cobra $4.000 por pasajero (mínimo 1 pax)
        // En moto a Distracción la comisión es $1.000
        const isDistraccionMoto = /distraccion/i.test(destStr);
        platformFee = isDistraccionMoto ? 1000 : 4000;
        courierEarnings = Math.max(total - platformFee, 0);
      } else {
        // Mototaxi urbano: 0% comisión por carrera (100% para el mototaxista)
        platformFee = 0;
        courierEarnings = total;
      }
    } else {
      // Domicilios de comida o compras en tienda
      if (deliveryFee <= 3000) {
        platformFee = 1000;
        courierEarnings = 2000;
      } else if (deliveryFee <= 5000) {
        platformFee = 1500;
        courierEarnings = 3500;
      } else {
        platformFee = 2000;
        courierEarnings = Math.max(deliveryFee - platformFee, 0);
      }
    }

    await client.query('BEGIN');

    // Limpiar asientos previos de esta orden para garantizar idempotencia
    await client.query('DELETE FROM ledger WHERE order_id = $1', [order.id]);

    if (order.payment_method === 'cash') {
      // Cliente paga en efectivo al conductor
      await client.query(
        'INSERT INTO ledger (order_id, account, debit, credit, memo) VALUES ($1, $2, $3, 0, $4)',
        [order.id, `caja_mensajero:${courierId}`, total, 'Efectivo recibido por conductor']
      );

      if (merchantPayout > 0) {
        await client.query(
          'INSERT INTO ledger (order_id, account, debit, credit, memo) VALUES ($1, $2, 0, $3, $4)',
          [order.id, `cxc_comercio:${merchantId}`, merchantPayout, 'Por pagar al comercio (100% producto)']
        );
      }

      if (platformFee > 0) {
        await client.query(
          'INSERT INTO ledger (order_id, account, debit, credit, memo) VALUES ($1, $2, 0, $3, $4)',
          [order.id, 'ingreso_comision', platformFee, 'Comisión servicio Fonsi']
        );
      }

      await client.query(
        'INSERT INTO ledger (order_id, account, debit, credit, memo) VALUES ($1, $2, 0, $3, $4)',
        [order.id, 'ingreso_domicilio', courierEarnings, 'Tarifa devengada por conductor']
      );

    } else if (order.payment_method === 'transfer') {
      // Cliente transfirió a la cuenta Bre-B central
      await client.query(
        'INSERT INTO ledger (order_id, account, debit, credit, memo) VALUES ($1, $2, $3, 0, $4)',
        [order.id, 'banco_empresa', total, 'Transferencia Bre-B recibida en cuenta central']
      );

      if (merchantPayout > 0) {
        await client.query(
          'INSERT INTO ledger (order_id, account, debit, credit, memo) VALUES ($1, $2, 0, $3, $4)',
          [order.id, `cxc_comercio:${merchantId}`, merchantPayout, 'Por pagar al comercio (100% producto)']
        );
      }

      if (platformFee > 0) {
        await client.query(
          'INSERT INTO ledger (order_id, account, debit, credit, memo) VALUES ($1, $2, 0, $3, $4)',
          [order.id, 'ingreso_comision', platformFee, 'Comisión servicio Fonsi']
        );
      }

      await client.query(
        'INSERT INTO ledger (order_id, account, debit, credit, memo) VALUES ($1, $2, 0, $3, $4)',
        [order.id, `cxp_mensajero:${courierId}`, courierEarnings, 'Tarifa adeudada al conductor por servicio Bre-B']
      );

    } else {
      // Pago mixto
      const transferPart = Number(order.transfer_part) || subtotal;
      const cashPart = Number(order.cash_part) || deliveryFee;

      await client.query(
        'INSERT INTO ledger (order_id, account, debit, credit, memo) VALUES ($1, $2, $3, 0, $4)',
        [order.id, 'banco_empresa', transferPart, 'Transferencia Bre-B producto']
      );
      await client.query(
        'INSERT INTO ledger (order_id, account, debit, credit, memo) VALUES ($1, $2, $3, 0, $4)',
        [order.id, `caja_mensajero:${courierId}`, cashPart, 'Efectivo recibido conductor']
      );

      if (merchantPayout > 0) {
        await client.query(
          'INSERT INTO ledger (order_id, account, debit, credit, memo) VALUES ($1, $2, 0, $3, $4)',
          [order.id, `cxc_comercio:${merchantId}`, merchantPayout, 'Por pagar al comercio (100% producto)']
        );
      }

      if (platformFee > 0) {
        await client.query(
          'INSERT INTO ledger (order_id, account, debit, credit, memo) VALUES ($1, $2, 0, $3, $4)',
          [order.id, 'ingreso_comision', platformFee, 'Comisión servicio Fonsi']
        );
      }

      await client.query(
        'INSERT INTO ledger (order_id, account, debit, credit, memo) VALUES ($1, $2, 0, $3, $4)',
        [order.id, 'ingreso_domicilio', courierEarnings, 'Tarifa devengada por conductor']
      );
    }

    // Validación estricta de Partida Doble
    const balanceRes = await client.query(
      'SELECT SUM(debit) as total_debit, SUM(credit) as total_credit FROM ledger WHERE order_id = $1',
      [order.id]
    );
    const { total_debit, total_credit } = balanceRes.rows[0];

    if (Number(total_debit) !== Number(total_credit)) {
      throw new Error(`Asiento descuadrado: Débito $${total_debit} != Crédito $${total_credit}`);
    }

    await client.query('COMMIT');
    return {
      status: 'success',
      order_id: order.id,
      code: order.code,
      total_debit: Number(total_debit),
      total_credit: Number(total_credit),
      balanced: true,
      platform_fee: platformFee,
      courier_earnings: courierEarnings
    };
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('Error en ledger_post:', err);
    return { status: 'error', error: err.message };
  } finally {
    await client.end();
  }
}
