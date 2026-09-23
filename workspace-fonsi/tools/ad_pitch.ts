/**
 * Devuelve los planes de publicidad disponibles para que Fonsi los ofrezca.
 */
export async function ad_pitch() {
  return {
    status: 'success',
    plans: [
      {
        id: 'destacado',
        name: '🌟 Destacado en recomendaciones',
        price: 80000,
        description: 'Tu comercio sale de primero con sello de aliado destacado.'
      },
      {
        id: 'estado',
        name: '📢 Estado de WhatsApp diario',
        price: 50000,
        description: 'Sales todos los días en el estado de Fonsi con foto y promo.'
      },
      {
        id: 'premium',
        name: '💎 Aliado Premium',
        price: 110000,
        description: 'Incluye Destacado + Estado + Promos proactivas en el chat.'
      }
    ],
    call_to_action: 'Pregúntale al comercio cuál plan le interesa más.'
  };
}
