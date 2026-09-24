/**
 * Cotiza tarifa de mandado libre o transporte en Fonseca y rutas intermunicipales.
 * 
 * Reglas de negocio oficiales:
 * - Urbano en Fonseca: SOLO Mototaxi ($3.000 1 persona / $4.000 2 personas).
 * - Intermunicipal en Mototaxi: ÚNICAMENTE Distracción ($5.000).
 * - Intermunicipal en Carro (4 cupos):
 *   • Barrancas: $8.000
 *   • San Juan del Cesar: $10.000
 *   • El Molino: $15.000
 *   • Hatonuevo: $15.000
 *   • Villanueva: $20.000
 *   • Urumita: $20.000
 *   • Maicao: $30.000
 *   • Riohacha: $40.000
 */
export async function fare_quote(
  type: 'ride' | 'package', 
  passengers: number = 1,
  origin?: string, 
  destination?: string,
  vehicleType?: 'moto' | 'carro'
) {
  // Destinos intermunicipales oficiales desde Fonseca
  const intermunicipalRates: Record<string, { city: string, vehicle: 'moto' | 'carro', price: number, desc: string }> = {
    'distraccion': { city: 'Distracción', vehicle: 'moto', price: 5000, desc: 'Mototaxi' },
    'barrancas': { city: 'Barrancas', vehicle: 'carro', price: 8000, desc: 'Carro (hasta 4 cupos)' },
    'san juan': { city: 'San Juan del Cesar', vehicle: 'carro', price: 10000, desc: 'Carro (hasta 4 cupos)' },
    'el molino': { city: 'El Molino', vehicle: 'carro', price: 15000, desc: 'Carro (hasta 4 cupos)' },
    'molino': { city: 'El Molino', vehicle: 'carro', price: 15000, desc: 'Carro (hasta 4 cupos)' },
    'hatonuevo': { city: 'Hatonuevo', vehicle: 'carro', price: 15000, desc: 'Carro (hasta 4 cupos)' },
    'villanueva': { city: 'Villanueva', vehicle: 'carro', price: 20000, desc: 'Carro (hasta 4 cupos)' },
    'urumita': { city: 'Urumita', vehicle: 'carro', price: 20000, desc: 'Carro (hasta 4 cupos)' },
    'maicao': { city: 'Maicao', vehicle: 'carro', price: 30000, desc: 'Carro (hasta 4 cupos)' },
    'riohacha': { city: 'Riohacha', vehicle: 'carro', price: 40000, desc: 'Carro (hasta 4 cupos)' }
  };

  const destNorm = (destination || '')
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  for (const [key, data] of Object.entries(intermunicipalRates)) {
    if (destNorm.includes(key)) {
      return {
        status: 'success',
        service: `Viaje Fonseca ↔ ${data.city} (${data.desc})`,
        vehicle: data.vehicle,
        fee: data.price,
        currency: 'COP',
        eta_range: data.vehicle === 'moto' ? '10-15 minutos' : '15-30 minutos de agendamiento',
        intermunicipal: true
      };
    }
  }

  if (type === 'ride') {
    const fee = passengers > 1 ? 4000 : 3000;
    return {
      status: 'success',
      service: `Carrera Urbana en Mototaxi (${passengers > 1 ? '2 personas' : '1 persona'})`,
      vehicle: 'moto',
      fee,
      passengers,
      currency: 'COP',
      pickup_eta: '3-5 min',
      trip_eta: '8-12 min',
      eta_range: '3-10 minutos'
    };
  } else {
    // Mandado urbano genérico
    return {
      status: 'success',
      service: 'Mandado Urbano (hasta 5 kg)',
      fee: 6000,
      currency: 'COP',
      eta_range: '20-35 minutos'
    };
  }
}
