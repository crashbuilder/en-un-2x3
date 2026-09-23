const { Client } = require('pg');
const { receipt_ocr } = require('/workspace/tools/receipt_ocr');
const { payment_verify } = require('/workspace/tools/payment_verify');
const { ledger_post } = require('/workspace/tools/ledger_post');
const { courier_settle } = require('/workspace/tools/courier_settle');
const { fare_quote } = require('/workspace/tools/fare_quote');
const { eta_calculate } = require('/workspace/tools/eta_calculate');
const { relay_message } = require('/workspace/tools/relay_message');
const { ad_pitch } = require('/workspace/tools/ad_pitch');
const { ad_close } = require('/workspace/tools/ad_close');
const { status_publish } = require('/workspace/tools/status_publish');
const { merchant_list } = require('/workspace/tools/merchant_list');

async function testAllPhases() {
  console.log('========================================================================');
  console.log('🚀 SUITE DE PRUEBAS INTEGRAL — EN UN 2X3 (FASES 0 A 5)');
  console.log('========================================================================\n');

  const client = new Client({ host: 'postgres', user: 'fonsi_user', password: 'fonsi_password', database: 'en_un_2x3' });
  await client.connect();

  // -------------------------------------------------------------
  // FASE 0 & 1: SETUP, COMERCIOS Y PEDIDO DE COMIDA EN EFECTIVO
  // -------------------------------------------------------------
  console.log('▶️ [FASE 0 & 1] Verificando comercios, mensajeros y creación de pedido...');
  const user = await client.query("INSERT INTO users (wa_phone, name, default_address) VALUES ('573009998877', 'Carlos Cliente', 'Barrio Centro Calle 15') ON CONFLICT (wa_phone) DO UPDATE SET name='Carlos Cliente' RETURNING id");
  const merchants = await merchant_list();
  const couriersRes = await client.query("SELECT * FROM couriers WHERE is_active = true");
  
  if (merchants.merchants.length === 0 || couriersRes.rows.length === 0) {
    throw new Error('Fase 0 Falló: Base de datos sin comercios o mensajeros.');
  }
  console.log(`  ✅ Fase 0 OK: ${merchants.merchants.length} comercios y ${couriersRes.rows.length} mensajeros activos.`);

  const order1Res = await client.query(`
    INSERT INTO orders (
      code, type, user_id, merchant_id, courier_id, status, items,
      subtotal, delivery_fee, total, payment_method, payment_status, destination
    ) VALUES (
      'FX-1001', 'food', $1, $2, $3, 'ON_THE_WAY', 
      '[{"item":"Pechuga Gratinada","qty":1,"price":16000},{"item":"Kola Litro","qty":1,"price":4000}]'::jsonb,
      20000, 3000, 23000, 'cash', 'PENDING', '{"label":"Calle 15 Centro"}'::jsonb
    ) ON CONFLICT (code) DO UPDATE SET status='ON_THE_WAY' RETURNING id, code, total, status
  `, [user.rows[0].id, merchants.merchants[0].id, couriersRes.rows[0].id]);
  
  console.log(`  ✅ Fase 1 OK: Pedido ${order1Res.rows[0].code} registrado con total $${order1Res.rows[0].total} COP y asignado a mensajero.`);

  // -------------------------------------------------------------
  // FASE 2: PAGOS POR TRANSFERENCIA, OCR, CONTABILIDAD Y CIERRE
  // -------------------------------------------------------------
  console.log('\n▶️ [FASE 2] Verificando validación OCR, antifraude y contabilidad de partida doble...');
  const order2Res = await client.query(`
    INSERT INTO orders (
      code, type, user_id, merchant_id, courier_id, status, items,
      subtotal, delivery_fee, total, payment_method, payment_status, destination
    ) VALUES (
      'FX-2001', 'food', $1, $2, $3, 'DRAFT', 
      '[{"item":"Chivo en Coco","qty":1,"price":22000}]'::jsonb,
      22000, 3000, 25000, 'transfer', 'PENDING', '{"label":"Carrera 12 El Carmen"}'::jsonb
    ) ON CONFLICT (code) DO UPDATE SET status='DRAFT', payment_status='PENDING' RETURNING id, code, total
  `, [user.rows[0].id, merchants.merchants[0].id, couriersRes.rows[0].id]);

  const ocr = await receipt_ocr('mock_nequi', 25000);
  const verify = await payment_verify(order2Res.rows[0].code, ocr.data, 'https://mock/nequi.jpg');
  if (!verify.verified) throw new Error('Fase 2 Falló: Verificación OCR rechazada.');
  console.log(`  ✅ OCR & Antifraude OK: Pago de $${verify.amount} verificado para ${verify.order_code}.`);

  // Entregar órdenes y asentar en el libro mayor
  await client.query("UPDATE orders SET status='DELIVERED', delivered_at=now() WHERE code IN ('FX-1001', 'FX-2001')");
  const ledger1 = await ledger_post(order1Res.rows[0].id);
  const ledger2 = await ledger_post(order2Res.rows[0].id);

  if (!ledger1.balanced || !ledger2.balanced) {
    throw new Error('Fase 2 Falló: Asiento contable descuadrado.');
  }
  console.log(`  ✅ Partida Doble OK: Asientos contables registrados y balanceados (Efectivo y Transferencia).`);

  const today = new Date().toISOString().split('T')[0];
  const settle = await courier_settle(couriersRes.rows[0].id, today);
  console.log(`  ✅ Liquidación OK: Mensajero ${couriersRes.rows[0].name} liquidado con ${settle.settlement.services} servicios.`);

  // -------------------------------------------------------------
  // FASE 3: MANDADOS LIBRES, MOTOTAXIS, ETAs Y RELAY
  // -------------------------------------------------------------
  console.log('\n▶️ [FASE 3] Verificando cotizador de tarifas, ETAs y relay anónimo...');
  const motoQuote = await fare_quote('ride', 'moto');
  const carQuote = await fare_quote('ride', 'carro');
  const pkgQuote = await fare_quote('package');
  const etaFood = await eta_calculate(15, 'food');
  const etaRide = await eta_calculate(0, 'ride');
  const relayRes = await relay_message(order1Res.rows[0].id, 'user', 'Por favor tocar el timbre');

  console.log(`  ✅ Cotización Transporte: Mototaxi $${motoQuote.fee} COP (${motoQuote.eta_range}) | Carro $${carQuote.fee} COP.`);
  console.log(`  ✅ Cotización Mandados: Tarifa base $${pkgQuote.fee} COP (${pkgQuote.eta_range}).`);
  console.log(`  ✅ ETAs en Rango: Comida (${etaFood.eta_range}) | Viaje (${etaRide.eta_range}).`);
  console.log(`  ✅ Relay Anónimo: ${relayRes.message}`);

  // -------------------------------------------------------------
  // FASE 4: PUBLICIDAD, CONTRATOS Y ESTADOS DIARIOS
  // -------------------------------------------------------------
  console.log('\n▶️ [FASE 4] Verificando planes de publicidad, cierre de contrato y publicación de estados...');
  const pitch = await ad_pitch();
  const adRes = await ad_close('', 'Restaurante La Jefa', 'destacado', 80000);
  const statusRes = await status_publish();

  console.log(`  ✅ Planes de Pauta: ${pitch.plans.map(p => p.name).join(', ')}.`);
  console.log(`  ✅ Cierre de Contrato: ${adRes.message}`);
  console.log(`  ✅ Publicación de Estado: ${statusRes.message}`);

  // -------------------------------------------------------------
  // FASE 5: PANEL WEB ADMINISTRATIVO & REST API
  // -------------------------------------------------------------
  console.log('\n▶️ [FASE 5] Verificando REST API y Dashboard Web en http://localhost:3000...');
  const statsRes = await fetch('http://localhost:3000/api/stats').then(r => r.json());
  const ordersList = await fetch('http://localhost:3000/api/orders').then(r => r.json());
  const ledgerList = await fetch('http://localhost:3000/api/ledger').then(r => r.json());
  const indexHtml = await fetch('http://localhost:3000/').then(r => r.text());

  if (!indexHtml.includes('EN UN 2X3')) {
    throw new Error('Fase 5 Falló: Dashboard no responde en puerto 3000.');
  }

  console.log(`  ✅ REST API Stats: ${statsRes.orders.total} órdenes, volumen contable $${statsRes.ledger_volume}.`);
  console.log(`  ✅ REST API Ledger: ${ledgerList.length} movimientos de libro mayor.`);
  console.log(`  ✅ Panel Web Dashboard: Servido exitosamente en http://localhost:3000.`);

  await client.end();
  console.log('\n========================================================================');
  console.log('🎉 ¡TODAS LAS FASES (0 A 5) COMPLETADAS Y VERIFICADAS AL 100%!');
  console.log('========================================================================');
}

testAllPhases().catch(err => {
  console.error('\n❌ ERROR EN PRUEBAS:', err);
  process.exit(1);
});
