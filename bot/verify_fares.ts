import { fare_quote } from '/workspace/tools/fare_quote';

async function verifyAllFares() {
  console.log("==========================================");
  console.log("🚕 VERIFICACIÓN DE TARIFAS OFICIALES");
  console.log("==========================================");

  const tests = [
    { type: 'ride', pass: 1, orig: 'Fonseca', dest: 'Barrio Primero de Julio', expected: 3000, veh: 'moto' },
    { type: 'ride', pass: 2, orig: 'Fonseca', dest: 'Hospital', expected: 4000, veh: 'moto' },
    { type: 'ride', pass: 1, orig: 'Fonseca', dest: 'Distracción', expected: 5000, veh: 'moto' },
    { type: 'ride', pass: 1, orig: 'Fonseca', dest: 'Barrancas', expected: 8000, veh: 'carro' },
    { type: 'ride', pass: 1, orig: 'Fonseca', dest: 'San Juan', expected: 10000, veh: 'carro' },
    { type: 'ride', pass: 1, orig: 'Fonseca', dest: 'El Molino', expected: 15000, veh: 'carro' },
    { type: 'ride', pass: 1, orig: 'Fonseca', dest: 'Hatonuevo', expected: 15000, veh: 'carro' },
    { type: 'ride', pass: 1, orig: 'Fonseca', dest: 'Villanueva', expected: 20000, veh: 'carro' },
    { type: 'ride', pass: 1, orig: 'Fonseca', dest: 'Urumita', expected: 20000, veh: 'carro' },
    { type: 'ride', pass: 1, orig: 'Fonseca', dest: 'Maicao', expected: 30000, veh: 'carro' },
    { type: 'ride', pass: 1, orig: 'Fonseca', dest: 'Riohacha', expected: 40000, veh: 'carro' },
  ];

  for (const t of tests) {
    const q = await fare_quote(t.type as any, t.pass, t.orig, t.dest);
    const pass = q.fee === t.expected && q.vehicle === t.veh;
    console.log(`${pass ? '✅' : '❌'} ${t.dest} (${t.pass} pax): $${q.fee} COP [${q.vehicle}] -> ${q.service}`);
  }

  console.log("==========================================");
}

verifyAllFares().catch(console.error);
