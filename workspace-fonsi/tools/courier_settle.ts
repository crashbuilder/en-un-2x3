import { Client } from 'pg';

/**
 * Liquidación diaria integral de conductores con:
 * 1. Suscripción diaria de mototaxi ($2.000 COP/día activo).
 * 2. Comisiones retenidas a Fonsi ($1.000 en 1 parada, $1.500 en 2 paradas, $4.000 en intermunicipal).
 */
export async function courier_settle(courierId: string, dateStr: string) {
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'fonsi_user',
    password: process.env.DB_PASSWORD || 'fonsi_password',
    database: process.env.DB_NAME || 'en_un_2x3'
  });

  await client.connect();

  try {
    // Obtener información del conductor (vehículo)
    const cRes = await client.query('SELECT id, name, vehicle FROM couriers WHERE id = $1', [courierId]);
    if (cRes.rows.length === 0) return { status: 'error', error: 'Courier not found' };
    const courier = cRes.rows[0];
    const isMoto = (courier.vehicle || '').toLowerCase().includes('moto');

    // Buscar órdenes DELIVERED de esa fecha por ese conductor
    const res = await client.query(`
      SELECT type, total, subtotal, delivery_fee, payment_method, cash_part, destination
      FROM orders 
      WHERE courier_id = $1 AND status = 'DELIVERED' 
      AND created_at::date = $2::date
    `, [courierId, dateStr]);

    const orders = res.rows;
    
    let cashCollected = 0;
    let feesEarned = 0;
    let urbanRidesCount = 0;

    orders.forEach(o => {
      const isRide = o.type === 'ride';
      const destStr = typeof o.destination === 'string' ? o.destination : (o.destination?.label || '');
      const isIntermunicipal = /distraccion|barrancas|san juan|molino|hatonuevo|villanueva|urumita|maicao|riohacha/i.test(destStr);
      
      let driverEarnings = 0;

      if (isRide) {
        if (isIntermunicipal) {
          const isDistraccionMoto = /distraccion/i.test(destStr);
          const platformFee = isDistraccionMoto ? 1000 : 4000;
          driverEarnings = Math.max(Number(o.total) - platformFee, 0);
        } else {
          // Mototaxi urbano: 100% de la tarifa es para el conductor
          driverEarnings = Number(o.total);
          urbanRidesCount++;
        }
      } else {
        // Domicilios de comida o compras
        const dFee = Number(o.delivery_fee) || 3000;
        if (dFee <= 3000) {
          driverEarnings = 2000;
        } else if (dFee <= 5000) {
          driverEarnings = 3500;
        } else {
          driverEarnings = Math.max(dFee - 2000, 0);
        }
      }

      feesEarned += driverEarnings;

      if (o.payment_method === 'cash') {
        cashCollected += Number(o.total);
      } else if (o.payment_method === 'mixed') {
        cashCollected += Number(o.cash_part) || 0;
      }
    });

    // Suscripción diaria de $2.000 COP para mototaxis si salieron a trabajar hoy (hicieron servicios)
    const shiftFee = (isMoto && orders.length > 0) ? 2000 : 0;

    // Fórmula neta: lo que cobró en efectivo - lo que ganó + la suscripción diaria
    const owedToCompanyCalc = (cashCollected - feesEarned) + shiftFee;
    const owedToCompany = Math.max(owedToCompanyCalc, 0);
    const owedByCompany = Math.max(-owedToCompanyCalc, 0);
    const net = owedToCompanyCalc;

    await client.query(`
      INSERT INTO settlements (
        courier_id, date, cash_collected, fees_earned, owed_to_company, owed_by_company, net, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'OPEN')
      ON CONFLICT (courier_id, date) DO UPDATE 
      SET cash_collected = $3, 
          fees_earned = $4, 
          owed_to_company = $5, 
          owed_by_company = $6,
          net = $7
    `, [courierId, dateStr, cashCollected, feesEarned, owedToCompany, owedByCompany, net]);

    return {
      status: 'success',
      settlement: {
        courier_id: courierId,
        courier_name: courier.name,
        vehicle: courier.vehicle,
        date: dateStr,
        services: orders.length,
        urban_rides: urbanRidesCount,
        shift_fee: shiftFee,
        cash_collected: cashCollected,
        fees_earned: feesEarned,
        owed_to_company: owedToCompany,
        owed_by_company: owedByCompany,
        net: net
      }
    };
  } catch (err: any) {
    return { status: 'error', error: err.message };
  } finally {
    await client.end();
  }
}
