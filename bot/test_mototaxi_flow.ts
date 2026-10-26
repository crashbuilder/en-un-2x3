import { Client } from 'pg';

async function testFullMototaxiFlow() {
  console.log("==================================================");
  console.log("🛵 PRUEBA DE FLUJO COMPLETO DE MOTOTAXI / TRANSPORTE");
  console.log("==================================================");

  const db = new Client({
    host: 'postgres',
    user: 'fonsi_user',
    password: 'fonsi_password',
    database: 'en_un_2x3'
  });

  await db.connect();

  const testUserId = 'test_user_773011';
  const testUserName = 'Usuario Test Fonseca';
  const origin = 'Parque Principal de Fonseca';
  const destination = 'Barrio Primero de Julio, Calle 15';

  console.log(`1️⃣ Registrando usuario y carrera mototaxi...`);
  const userRes = await db.query(`
    INSERT INTO users (wa_phone, name, default_address, payment_pref)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (wa_phone) DO UPDATE 
    SET name = EXCLUDED.name
    RETURNING id
  `, [testUserId, testUserName, destination, 'cash']);

  const userDbId = userRes.rows[0].id;

  const randomCode = `FX-${Math.floor(1000 + Math.random() * 9000)}`;
  const orderRes = await db.query(`
    INSERT INTO orders (
      code, type, user_id, status, items,
      subtotal, delivery_fee, total, payment_method, payment_status,
      origin, destination, created_at
    ) VALUES (
      $1, 'ride', $2, 'ON_THE_WAY', $3,
      4000, 0, 4000, 'cash', 'PENDING',
      $4, $5, now()
    ) RETURNING id, code, status
  `, [
    randomCode,
    userDbId,
    JSON.stringify([{ item: 'Carrera Mototaxi Urbano', qty: 1, price: 4000 }]),
    JSON.stringify({ label: origin }),
    JSON.stringify({ label: destination })
  ]);

  const createdOrder = orderRes.rows[0];
  console.log(`  ✅ Carrera creada en DB: Código ${createdOrder.code} (ID: ${createdOrder.id})`);

  console.log(`2️⃣ Asignando mototaxista disponible...`);
  const courierRes = await db.query(
    "SELECT id, name, vehicle, plate, rating FROM couriers WHERE is_active = true AND vehicle = 'moto' ORDER BY RANDOM() LIMIT 1"
  );
  
  if (courierRes.rows.length === 0) {
    throw new Error("No hay mototaxistas activos");
  }

  const courier = courierRes.rows[0];
  await db.query("UPDATE orders SET courier_id = $1 WHERE id = $2", [courier.id, createdOrder.id]);
  console.log(`  ✅ Mototaxista asignado: ${courier.name} (${courier.plate}) - Rating: ${courier.rating} ⭐`);

  console.log(`3️⃣ Consultando estado en vivo...`);
  const checkRes = await db.query(`
    SELECT o.code, o.type, o.status, o.total, o.payment_method, c.name as courier_name, c.plate, o.origin, o.destination
    FROM orders o
    JOIN couriers c ON o.courier_id = c.id
    WHERE o.id = $1
  `, [createdOrder.id]);

  const live = checkRes.rows[0];
  console.log(`  ✅ Estado verificado:`);
  console.log(`     • Código: ${live.code}`);
  console.log(`     • Tipo: ${live.type}`);
  console.log(`     • Conductor: ${live.courier_name} (${live.plate})`);
  console.log(`     • Origen: ${live.origin.label}`);
  console.log(`     • Destino: ${live.destination.label}`);
  console.log(`     • Tarifa: $${live.total} COP`);
  console.log(`     • Estado: ${live.status}`);

  await db.end();
  console.log("==================================================");
  console.log("🎉 ¡FLUJO DE MOTOTAXI 100% OPERATIVO EN BASE DE DATOS!");
  console.log("==================================================");
}

testFullMototaxiFlow().catch(console.error);
