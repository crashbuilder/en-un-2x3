/**
 * Cotiza tarifa de mandado libre o transporte (moto/carro) en Fonseca y alrededores.
 */
export async function fare_quote(
  type: 'ride' | 'package', 
  vehicleType: 'moto' | 'carro' = 'moto',
  origin?: string, 
  destination?: string
) {
  // Destinos intermunicipales desde Fonseca
  const intermunicipal: Record<string, number> = {
    'valledupar': 45000,
    'riohacha': 50000,
    'barranquilla': 120000,
    'san juan': 15000,
    'distraccion': 10000,
    'villanueva': 25000
  };

  const destNorm = (destination || '').toLowerCase();
  for (const [city, price] of Object.entries(intermunicipal)) {
    if (destNorm.includes(city)) {
      return {
        status: 'success',
        service: `Viaje Intermunicipal Fonseca ↔ ${city.toUpperCase()}`,
        vehicle: vehicleType,
        fee: vehicleType === 'carro' ? price : Math.round(price * 0.6),
        currency: 'COP',
        eta_range: '30-45 minutos de agendamiento previo',
        intermunicipal: true
      };
    }
  }

  if (type === 'ride') {
    const isCar = vehicleType === 'carro';
    return {
      status: 'success',
      service: isCar ? 'Carrera en Carro' : 'Carrera en Mototaxi',
      vehicle: vehicleType,
      fee: isCar ? 8000 : 4000,
      currency: 'COP',
      pickup_eta: isCar ? '5-7 min' : '3-5 min',
      trip_eta: '8-12 min',
      eta_range: isCar ? '5-15 minutos' : '3-10 minutos'
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
