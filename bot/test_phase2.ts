const { Client } = require('pg');
const { receipt_ocr } = require('/workspace/tools/receipt_ocr');
const { payment_verify } = require('/workspace/tools/payment_verify');
const { ledger_post } = require('/workspace/tools/ledger_post');
const { courier_settle } = require('/workspace/tools/courier_settle');

async function testPhase2() {
  console.log('--- TEST FASE 2: PAGOS OCR Y CONTABILIDAD ---');
  const client = new Client({ host: 'postgres', user: 'fonsi_user', password: 'fonsi_password', database: 'en_un_2x3' });
  await client.connect();

  // 1. Crear orden de prueba por transferencia
  const user = await client.query("INSERT INTO users (wa_phone, name) VALUES ('999001', 'Juan Prueba') ON CONFLICT (wa_phone) DO UPDATE SET name='Juan Prueba' RETURNING id");
  const merchant = await client.query('SELECT id FROM merchants LIMIT 1');
  const courier = await client.query('SELECT id FROM couriers LIMIT 1');

  const orderRes = await client.query("INSERT INTO orders (code, type, user_id, merchant_id, courier_id, status, items, subtotal, delivery_fee, total, payment_method, payment_status) VALUES ('FX-2002', 'food', $1, $2, $3, 'DRAFT', '[{\"item\":\"Plato Especial\",\"qty\":1,\"price\":24000}]'::jsonb, 24000, 3000, 27000, 'transfer', 'PENDING') ON CONFLICT (code) DO UPDATE SET status='DRAFT', payment_status='PENDING' RETURNING id, code", [user.rows[0].id, merchant.rows[0].id, courier.rows[0].id]);
  const orderId = orderRes.rows[0].id;
  const orderCode = orderRes.rows[0].code;

  console.log('1. Orden creada:', orderCode);

  // 2. Simular OCR y Validación de Pago
  const ocrData = await receipt_ocr('mock_image', 27000);
  console.log('2. OCR extraído:', ocrData.data);

  const verifyRes = await payment_verify(orderCode, ocrData.data, 'https://mock/receipt.jpg');
  console.log('3. Resultado Payment Verify:', verifyRes);

  // 4. Test Anti-fraude (reintento con misma referencia)
  const duplicateRes = await payment_verify(orderCode, ocrData.data, 'https://mock/receipt.jpg');
  console.log('4. Test Anti-Fraude Referencia Duplicada:', duplicateRes.error ? 'PASÓ (Rechazado correctamente)' : 'FALLÓ');

  // 5. Test Ledger Post (Entrega y Partida Doble)
  await client.query("UPDATE orders SET status = 'DELIVERED', delivered_at = now() WHERE id = $1", [orderId]);
  const ledgerRes = await ledger_post(orderId);
  console.log('5. Resultado Ledger Post:', ledgerRes);

  // 6. Test Courier Settle (Liquidación)
  const today = new Date().toISOString().split('T')[0];
  const settleRes = await courier_settle(courier.rows[0].id, today);
  console.log('6. Resultado Courier Settle:', settleRes);

  await client.end();
  console.log('--- TODOS LOS TESTS DE FASE 2 EJECUTADOS CON ÉXITO ---');
}

testPhase2().catch(console.error);
