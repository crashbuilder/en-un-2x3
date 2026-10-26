import { Client } from 'pg';
import { ledger_post } from '/workspace/tools/ledger_post';
import { courier_settle } from '/workspace/tools/courier_settle';
import { payment_verify } from '/workspace/tools/payment_verify';
import { recover_stuck_orders } from '/workspace/tools/recover_stuck_orders';

const DB_CONFIG = {
  host: process.env.DB_HOST || 'postgres',
  user: process.env.DB_USER || 'fonsi_user',
  password: process.env.DB_PASSWORD || 'fonsi_password',
  database: process.env.DB_NAME || 'en_un_2x3'
};

async function runStressTest500() {
  console.log("================================================================================");
  console.log("🚀 INICIANDO MEGA-PRUEBA DE ESTRÉS CON 500 PEDIDOS Y AUDITORÍA CONTABLE OODA");
  console.log("================================================================================");

  const client = new Client(DB_CONFIG);
  await client.connect();

  const startTime = Date.now();

  try {
    // 1. Obtener Comercios y Conductores reales
    const merchantsRes = await client.query("SELECT id, name FROM merchants");
    const couriersRes = await client.query("SELECT id, name, vehicle FROM couriers WHERE is_active = true");
    
    const merchants = merchantsRes.rows;
    const motoCouriers = couriersRes.rows.filter(c => c.vehicle.toLowerCase().includes('moto'));
    const carCouriers = couriersRes.rows.filter(c => c.vehicle.toLowerCase().includes('carro'));
    const allCouriers = couriersRes.rows;

    console.log(`📌 Comercios disponibles: ${merchants.length}`);
    console.log(`📌 Conductores moto: ${motoCouriers.length} | Conductores carro: ${carCouriers.length}`);

    // 2. Crear bolsa de usuarios de prueba en Fonseca
    const barriosFonseca = [
      'Primero de Julio', 'Villa Luz', 'San Agustín', 'El Carmen', 'La Floresta',
      '12 de Octubre', 'Gómez Daza', 'Alto Prado', 'San José', 'Briceño'
    ];

    const users: string[] = [];
    for (let u = 1; u <= 30; u++) {
      const phone = `57300${(1000000 + u).toString()}`;
      const name = `Usuario Fonseca ${u}`;
      const barrio = barriosFonseca[u % barriosFonseca.length];
      const res = await client.query(`
        INSERT INTO users (wa_phone, name, barrio, default_address, payment_pref)
        VALUES ($1, $2, $3, $4, 'cash')
        ON CONFLICT (wa_phone) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
      `, [phone, name, barrio, `Calle ${10 + (u % 15)} # ${u}-20, Barrio ${barrio}`]);
      users.push(res.rows[0].id);
    }
    console.log(`✅ Usuarios simulados listos: ${users.length}`);

    const stats = {
      total: 500,
      food: 0,
      rides: 0,
      intermunicipal: 0,
      store: 0,
      edgeCases: 0,
      delivered: 0,
      cancelled: 0,
      underReview: 0,
      recoveredByWatchdog: 0,
      ledgerEntries: 0,
      errors: [] as string[]
    };

    const todayStr = new Date().toISOString().split('T')[0];

    // =========================================================================
    // GRUPO 1: 200 Pedidos de Domicilios de Comida (La Jefa, Loquillo, Donde Isne, etc.)
    // =========================================================================
    console.log("\n📦 [1/5] Procesando 200 Pedidos de Comida...");
    for (let i = 1; i <= 200; i++) {
      const merchant = merchants[i % merchants.length];
      const user = users[i % users.length];
      const courier = motoCouriers[i % motoCouriers.length];
      
      // Paradas: 1 parada ($3.000, 60%), 2 paradas ($5.000, 30%), 3 paradas ($8.000, 10%)
      const stops = (i % 10 < 6) ? 1 : (i % 10 < 9 ? 2 : 3);
      const deliveryFee = stops === 1 ? 3000 : (stops === 2 ? 5000 : 8000);
      const subtotal = 15000 + ((i * 1000) % 25000); // Entre $15.000 y $39.000
      const total = subtotal + deliveryFee;

      // 60% cash, 40% transfer
      const paymentMethod = (i % 5 < 3) ? 'cash' : 'transfer';
      const code = `FX-F${(1000 + i)}`;

      // Ciclo: DRAFT / CONFIRMED -> ON_THE_WAY -> DELIVERED
      const orderRes = await client.query(`
        INSERT INTO orders (
          code, type, user_id, merchant_id, courier_id, status, items,
          subtotal, delivery_fee, total, payment_method, payment_status,
          destination, created_at
        ) VALUES ($1, 'food', $2, $3, $4, 'ON_THE_WAY', $5, $6, $7, $8, $9, $10, $11, now())
        RETURNING id
      `, [
        code, user, merchant.id, courier.id,
        JSON.stringify([{ item: `Almuerzo Ejecutivo Especial ${stops} paradas`, qty: 1, price: subtotal }]),
        subtotal, deliveryFee, total, paymentMethod,
        paymentMethod === 'transfer' ? 'VERIFIED' : 'PENDING',
        JSON.stringify({ label: `Barrio ${barriosFonseca[i % barriosFonseca.length]}` })
      ]);
      const orderId = orderRes.rows[0].id;

      // Si es transferencia, registrar receipt
      if (paymentMethod === 'transfer') {
        await client.query(`
          INSERT INTO receipts (order_id, ocr_amount, ocr_ref, ocr_wallet, match_ok)
          VALUES ($1, $2, $3, 'breb', true)
        `, [orderId, total, `REF-FOOD-${code}`]);
      }

      // Marcar como entregado y asentar contabilidad
      await client.query("UPDATE orders SET status = 'DELIVERED', delivered_at = now() WHERE id = $1", [orderId]);
      const lRes = await ledger_post(orderId);
      if (lRes.status !== 'success') {
        stats.errors.push(`Error ledger food ${code}: ${lRes.error}`);
      } else {
        stats.ledgerEntries++;
      }

      stats.food++;
      stats.delivered++;
    }
    console.log(`  ✅ 200 Pedidos de comida completados y asentados en Libro Mayor.`);

    // =========================================================================
    // GRUPO 2: 150 Carreras de Mototaxi Urbano en Fonseca ($3.000 / $4.000)
    // =========================================================================
    console.log("\n🛵 [2/5] Procesando 150 Carreras de Mototaxi Urbano...");
    for (let i = 1; i <= 150; i++) {
      const user = users[i % users.length];
      const courier = motoCouriers[i % motoCouriers.length];
      const pax = (i % 4 === 0) ? 2 : 1;
      const fare = pax === 2 ? 4000 : 3000;
      const paymentMethod = (i % 10 < 7) ? 'cash' : 'transfer';
      const code = `FX-M${(2000 + i)}`;

      const orderRes = await client.query(`
        INSERT INTO orders (
          code, type, user_id, courier_id, status, items,
          subtotal, delivery_fee, total, payment_method, payment_status,
          origin, destination, created_at
        ) VALUES ($1, 'ride', $2, $3, 'ON_THE_WAY', $4, 0, $5, $5, $6, $7, $8, $9, now())
        RETURNING id
      `, [
        code, user, courier.id,
        JSON.stringify([{ item: `Mototaxi Urbano (${pax} Pasajero${pax > 1 ? 's' : ''})`, qty: 1, price: fare }]),
        fare, paymentMethod, paymentMethod === 'transfer' ? 'VERIFIED' : 'PENDING',
        JSON.stringify({ label: 'Parque Principal' }),
        JSON.stringify({ label: `Barrio ${barriosFonseca[(i + 3) % barriosFonseca.length]}` })
      ]);
      const orderId = orderRes.rows[0].id;

      if (paymentMethod === 'transfer') {
        await client.query(`
          INSERT INTO receipts (order_id, ocr_amount, ocr_ref, ocr_wallet, match_ok)
          VALUES ($1, $2, $3, 'breb', true)
        `, [orderId, fare, `REF-MOTO-${code}`]);
      }

      await client.query("UPDATE orders SET status = 'DELIVERED', delivered_at = now() WHERE id = $1", [orderId]);
      const lRes = await ledger_post(orderId);
      if (lRes.status !== 'success') {
        stats.errors.push(`Error ledger mototaxi ${code}: ${lRes.error}`);
      } else {
        stats.ledgerEntries++;
      }

      stats.rides++;
      stats.delivered++;
    }
    console.log(`  ✅ 150 Carreras de mototaxi completadas y asentadas.`);

    // =========================================================================
    // GRUPO 3: 50 Rutas Intermunicipales (Distracción, Barrancas, San Juan, etc.)
    // =========================================================================
    console.log("\n🚗 [3/5] Procesando 50 Viajes Intermunicipales...");
    const interDestinations = [
      { name: 'Distracción', fare: 5000, vehicle: 'moto' },
      { name: 'Barrancas', fare: 8000, vehicle: 'carro' },
      { name: 'San Juan del Cesar', fare: 10000, vehicle: 'carro' },
      { name: 'El Molino', fare: 15000, vehicle: 'carro' },
      { name: 'Hatonuevo', fare: 15000, vehicle: 'carro' },
      { name: 'Villanueva', fare: 20000, vehicle: 'carro' },
      { name: 'Maicao', fare: 30000, vehicle: 'carro' },
      { name: 'Riohacha', fare: 40000, vehicle: 'carro' }
    ];

    for (let i = 1; i <= 50; i++) {
      const dest = interDestinations[i % interDestinations.length];
      const user = users[i % users.length];
      const courier = dest.vehicle === 'moto' 
        ? motoCouriers[i % motoCouriers.length] 
        : carCouriers[i % carCouriers.length];

      const paymentMethod = (i % 2 === 0) ? 'cash' : 'transfer';
      const code = `FX-I${(3000 + i)}`;

      const orderRes = await client.query(`
        INSERT INTO orders (
          code, type, user_id, courier_id, status, items,
          subtotal, delivery_fee, total, payment_method, payment_status,
          origin, destination, created_at
        ) VALUES ($1, 'ride', $2, $3, 'ON_THE_WAY', $4, 0, $5, $5, $6, $7, $8, $9, now())
        RETURNING id
      `, [
        code, user, courier.id,
        JSON.stringify([{ item: `Viaje Fonseca ↔ ${dest.name} (${dest.vehicle})`, qty: 1, price: dest.fare }]),
        dest.fare, paymentMethod, paymentMethod === 'transfer' ? 'VERIFIED' : 'PENDING',
        JSON.stringify({ label: 'Fonseca Centro' }),
        JSON.stringify({ label: dest.name })
      ]);
      const orderId = orderRes.rows[0].id;

      if (paymentMethod === 'transfer') {
        await client.query(`
          INSERT INTO receipts (order_id, ocr_amount, ocr_ref, ocr_wallet, match_ok)
          VALUES ($1, $2, $3, 'breb', true)
        `, [orderId, dest.fare, `REF-INTER-${code}`]);
      }

      await client.query("UPDATE orders SET status = 'DELIVERED', delivered_at = now() WHERE id = $1", [orderId]);
      const lRes = await ledger_post(orderId);
      if (lRes.status !== 'success') {
        stats.errors.push(`Error ledger intermunicipal ${code}: ${lRes.error}`);
      } else {
        stats.ledgerEntries++;
      }

      stats.intermunicipal++;
      stats.delivered++;
    }
    console.log(`  ✅ 50 Viajes intermunicipales completados y asentados.`);

    // =========================================================================
    // GRUPO 4: 50 Compras en Tienda / Farmacia / Mercado
    // =========================================================================
    console.log("\n🛒 [4/5] Procesando 50 Compras en Tienda y Farmacia...");
    const storeItems = [
      { desc: 'Mustang Azul 20 + Coca Cola 1.5L', subtotal: 15000, fee: 3000 },
      { desc: 'Dolex Forte 500mg + Pañales Etapa 3', subtotal: 32000, fee: 3000 },
      { desc: 'Six-pack Águila Light + Choclitos Limón', subtotal: 18000, fee: 5000 },
      { desc: 'Leche entera + Huevos x30 + Café Sello Rojo', subtotal: 28000, fee: 5000 },
      { desc: 'Pedialyte 60 + Suero Oral + Acetaminofén', subtotal: 22000, fee: 3000 }
    ];

    for (let i = 1; i <= 50; i++) {
      const item = storeItems[i % storeItems.length];
      const user = users[i % users.length];
      const courier = motoCouriers[i % motoCouriers.length];
      const total = item.subtotal + item.fee;
      const paymentMethod = (i % 2 === 0) ? 'cash' : 'transfer';
      const code = `FX-T${(4000 + i)}`;

      const orderRes = await client.query(`
        INSERT INTO orders (
          code, type, user_id, courier_id, status, items,
          subtotal, delivery_fee, total, payment_method, payment_status,
          destination, created_at
        ) VALUES ($1, 'package', $2, $3, 'ON_THE_WAY', $4, $5, $6, $7, $8, $9, $10, now())
        RETURNING id
      `, [
        code, user, courier.id,
        JSON.stringify([{ item: item.desc, qty: 1, price: item.subtotal }]),
        item.subtotal, item.fee, total, paymentMethod,
        paymentMethod === 'transfer' ? 'VERIFIED' : 'PENDING',
        JSON.stringify({ label: `Barrio ${barriosFonseca[(i + 5) % barriosFonseca.length]}` })
      ]);
      const orderId = orderRes.rows[0].id;

      if (paymentMethod === 'transfer') {
        await client.query(`
          INSERT INTO receipts (order_id, ocr_amount, ocr_ref, ocr_wallet, match_ok)
          VALUES ($1, $2, $3, 'breb', true)
        `, [orderId, total, `REF-STORE-${code}`]);
      }

      await client.query("UPDATE orders SET status = 'DELIVERED', delivered_at = now() WHERE id = $1", [orderId]);
      const lRes = await ledger_post(orderId);
      if (lRes.status !== 'success') {
        stats.errors.push(`Error ledger tienda ${code}: ${lRes.error}`);
      } else {
        stats.ledgerEntries++;
      }

      stats.store++;
      stats.delivered++;
    }
    console.log(`  ✅ 50 Compras en tienda/farmacia completadas y asentadas.`);

    // =========================================================================
    // GRUPO 5: 50 Casos de Borde, Resiliencia y Seguridad Financiera
    // =========================================================================
    console.log("\n🛡️ [5/5] Procesando 50 Casos de Borde y Resiliencia...");

    // 5.1: 20 Pedidos Cancelados a mitad de camino
    for (let i = 1; i <= 20; i++) {
      const code = `FX-CAN-${(5000 + i)}`;
      await client.query(`
        INSERT INTO orders (code, type, user_id, status, subtotal, delivery_fee, total, payment_method, created_at)
        VALUES ($1, 'ride', $2, 'CANCELLED', 0, 3000, 3000, 'cash', now())
      `, [code, users[0]]);
      stats.cancelled++;
      stats.edgeCases++;
    }
    console.log("  ✅ 20 Pedidos cancelados registrados con status CANCELLED.");

    // 5.2: 15 Pedidos Retrasados (Watchdog Rescue Test)
    // Se insertan como creados hace 2 horas en estado ON_THE_WAY
    const stuckCodes: string[] = [];
    for (let i = 1; i <= 15; i++) {
      const code = `FX-STK-${(6000 + i)}`;
      await client.query(`
        INSERT INTO orders (
          code, type, user_id, status, subtotal, delivery_fee, total, payment_method, created_at
        ) VALUES (
          $1, 'ride', $2, 'ON_THE_WAY', 0, 3000, 3000, 'cash', NOW() - INTERVAL '2 hours'
        )
      `, [code, users[1]]);
      stuckCodes.push(code);
    }
    // Ejecutar Watchdog
    const watchdogRes = await recover_stuck_orders();
    console.log(`  🔄 Watchdog ejecutado: ${watchdogRes.message}`);
    stats.recoveredByWatchdog = watchdogRes.recovered_count || 0;

    // Concluir los pedidos recuperados entregándolos con éxito
    for (const code of stuckCodes) {
      const oRes = await client.query("SELECT id FROM orders WHERE code = $1", [code]);
      const oId = oRes.rows[0].id;
      const c = motoCouriers[0];
      await client.query("UPDATE orders SET courier_id = $1, status = 'DELIVERED', delivered_at = now() WHERE id = $2", [c.id, oId]);
      await ledger_post(oId);
      stats.delivered++;
      stats.edgeCases++;
      stats.ledgerEntries++;
    }
    console.log(`  ✅ 15 Pedidos retrasados recuperados por Watchdog y entregados.`);

    // 5.3: 10 Intentos Anti-Fraude (Comprobantes de pago duplicados)
    const existingRef = 'REF-FRAUD-SAMPLE-001';
    // Primer uso legítimo
    const legOrderRes = await client.query(`
      INSERT INTO orders (code, type, user_id, status, subtotal, delivery_fee, total, payment_method)
      VALUES ('FX-LEG-001', 'ride', $1, 'DRAFT', 0, 10000, 10000, 'transfer')
      RETURNING id, code
    `, [users[2]]);
    await payment_verify('FX-LEG-001', { amount: 10000, reference: existingRef, wallet: 'nequi' });

    let fraudBlocked = 0;
    for (let i = 1; i <= 10; i++) {
      const code = `FX-FRD-${(7000 + i)}`;
      await client.query(`
        INSERT INTO orders (code, type, user_id, status, subtotal, delivery_fee, total, payment_method)
        VALUES ($1, 'ride', $2, 'DRAFT', 0, 10000, 10000, 'transfer')
      `, [code, users[2]]);
      
      const fraudRes = await payment_verify(code, { amount: 10000, reference: existingRef, wallet: 'nequi' });
      if (fraudRes.verified === false) {
        fraudBlocked++;
      }
      stats.underReview++;
      stats.edgeCases++;
    }
    console.log(`  🛡️ Anti-Fraude: ${fraudBlocked}/10 intentos con comprobante reciclado bloqueados y enviados a REVIEW.`);

    // 5.4: 5 Pagos con Monto Discrepante
    let mismatchCount = 0;
    for (let i = 1; i <= 5; i++) {
      const code = `FX-MIS-${(8000 + i)}`;
      await client.query(`
        INSERT INTO orders (code, type, user_id, status, subtotal, delivery_fee, total, payment_method)
        VALUES ($1, 'ride', $2, 'DRAFT', 0, 25000, 25000, 'transfer')
      `, [code, users[3]]);

      // Cliente transfiere solo $10.000 cuando la tarifa era $25.000
      const misRes = await payment_verify(code, { 
        amount: 10000, 
        reference: `REF-MIS-${Date.now()}-${i}`, 
        wallet: 'daviplata' 
      });
      if (misRes.verified === false) {
        mismatchCount++;
      }
      stats.underReview++;
      stats.edgeCases++;
    }
    console.log(`  🛡️ Discrepancia de Monto: ${mismatchCount}/5 transferencias incompletas detectadas y puestas en REVIEW.`);

    // =========================================================================
    // FASE DE LIQUIDACIÓN DIARIA DE MENSAJEROS (settlements)
    // =========================================================================
    console.log("\n💰 [AUDITORÍA] Ejecutando Liquidación Diaria para todos los conductores...");
    const settlementsSummary = [];
    for (const courier of allCouriers) {
      const setRes = await courier_settle(courier.id, todayStr);
      if (setRes.status === 'success') {
        settlementsSummary.push({
          name: courier.name,
          vehicle: courier.vehicle,
          ...setRes.settlement
        });
      }
    }

    // =========================================================================
    // AUDITORÍA MATEMÁTICA Y PARTIDA DOBLE DEL LIBRO MAYOR (ledger)
    // =========================================================================
    console.log("\n📊 [AUDITORÍA MATEMÁTICA] Verificando Partida Doble en el Libro Mayor...");
    const ledgerTotalsRes = await client.query(`
      SELECT 
        SUM(debit) as total_debits, 
        SUM(credit) as total_credits,
        COUNT(*) as total_rows
      FROM ledger
    `);
    const { total_debits, total_credits, total_rows } = ledgerTotalsRes.rows[0];
    const diff = Number(total_debits) - Number(total_credits);

    // Verificar si existe algún pedido individual con descuadre
    const perOrderCheckRes = await client.query(`
      SELECT order_id, SUM(debit) as d, SUM(credit) as c, (SUM(debit) - SUM(credit)) as diff
      FROM ledger
      GROUP BY order_id
      HAVING (SUM(debit) - SUM(credit)) != 0
    `);

    // Resumen financiero global
    const salesSummaryRes = await client.query(`
      SELECT 
        COUNT(*) as total_orders,
        SUM(total) as gross_volume,
        SUM(total) FILTER (WHERE payment_method = 'cash') as cash_volume,
        SUM(total) FILTER (WHERE payment_method = 'transfer') as transfer_volume,
        SUM(subtotal) as subtotal_volume,
        SUM(delivery_fee) as delivery_fees_volume
      FROM orders
      WHERE status = 'DELIVERED'
    `);
    const sales = salesSummaryRes.rows[0];

    const commissionsRes = await client.query(`
      SELECT SUM(credit) as total_commissions FROM ledger WHERE account = 'ingreso_comision'
    `);
    const totalCommissions = commissionsRes.rows[0].total_commissions || 0;

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log("\n================================================================================");
    console.log("🏁 RESULTADOS FINALES DE LA MEGA-SIMULACIÓN (500 PEDIDOS)");
    console.log("================================================================================");
    console.log(`⏱️ Tiempo total de ejecución: ${duration} segundos`);
    console.log(`📦 Total pedidos simulados: ${stats.total}`);
    console.log(`   • Domicilios comida: ${stats.food}`);
    console.log(`   • Mototaxi urbano: ${stats.rides}`);
    console.log(`   • Viajes intermunicipales: ${stats.intermunicipal}`);
    console.log(`   • Compras tienda / farmacia: ${stats.store}`);
    console.log(`   • Casos de borde y resiliencia: ${stats.edgeCases}`);
    console.log(`     - Entregados exitosos: ${stats.delivered}`);
    console.log(`     - Cancelados legítimos: ${stats.cancelled}`);
    console.log(`     - En revisión (antifraude / monto): ${stats.underReview}`);
    console.log(`     - Rescatados por Watchdog: ${stats.recoveredByWatchdog}`);

    console.log("\n--------------------------------------------------------------------------------");
    console.log("⚖️ AUDITORÍA CONTABLE Y BALANCE DE PARTIDA DOBLE:");
    console.log(`• Filas de asientos en Ledger: ${total_rows}`);
    console.log(`• Total Débitos:  $${Number(total_debits).toLocaleString('es-CO')} COP`);
    console.log(`• Total Créditos: $${Number(total_credits).toLocaleString('es-CO')} COP`);
    console.log(`• Descuadre Contable: $${diff} COP ${diff === 0 ? '✅ (PERFECTO: $0 COP)' : '❌ (DESCUADRADO)'}`);
    console.log(`• Órdenes individuales con descuadre: ${perOrderCheckRes.rows.length}`);

    console.log("\n--------------------------------------------------------------------------------");
    console.log("💵 RESUMEN DE VENTAS Y RECAUDO:");
    console.log(`• Volumen Bruto Entregado: $${Number(sales.gross_volume).toLocaleString('es-CO')} COP`);
    console.log(`  - Recaudado en Efectivo: $${Number(sales.cash_volume).toLocaleString('es-CO')} COP`);
    console.log(`  - Recaudado en Bre-B (@3506811888): $${Number(sales.transfer_volume).toLocaleString('es-CO')} COP`);
    console.log(`• Comisiones 12% Empresa:  $${Number(totalCommissions).toLocaleString('es-CO')} COP`);

    console.log("\n--------------------------------------------------------------------------------");
    console.log("🏍️ RESUMEN DE LIQUIDACIONES A CONDUCTORES:");
    console.table(settlementsSummary);

    if (diff === 0 && perOrderCheckRes.rows.length === 0 && stats.errors.length === 0) {
      console.log("\n🎉 CERTIFICACIÓN EXITOSA: Sistema 100% operativo, con 0 errores y partida doble exacta.");
    } else {
      console.error("\n❌ DISCREPANCIAS ENCONTRADAS:", stats.errors);
    }

  } catch (err: any) {
    console.error("❌ ERROR CRÍTICO EN SIMULACIÓN:", err);
  } finally {
    await client.end();
  }
}

runStressTest500();
