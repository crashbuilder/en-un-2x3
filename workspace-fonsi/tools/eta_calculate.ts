/**
 * Calcula un ETA estimado en un rango (p50-p90) en minutos.
 * @param prepMin Minutos estimados de preparación (del comercio)
 * @param type 'food' | 'ride' | 'package'
 */
export async function eta_calculate(prepMin: number = 0, type: string = 'food') {
  // Para la Fase 1 usamos un modelo simple:
  // ETA = Preparación + Ride to Merchant (~5 min) + Ride to Client (~10 min) + Buffer
  
  let baseMinutes = 0;
  
  if (type === 'food') {
    baseMinutes = prepMin + 5 + 10;
  } else if (type === 'ride') {
    baseMinutes = 5; // Recogida rápida
  } else {
    baseMinutes = 15; // Mandados urbanos
  }

  const p50 = baseMinutes;
  const p90 = Math.ceil(baseMinutes * 1.3); // +30% como margen (clima, etc)

  return {
    status: 'success',
    eta_range: `${p50}-${p90} minutos`,
    p50,
    p90
  };
}
