/**
 * Intermedia mensajes entre usuario y mensajero sin exponer números.
 */
export async function relay_message(orderId: string, fromRole: 'user' | 'courier', message: string) {
  // Simulando reenvío mediante el gateway
  console.log(`[Relay Order ${orderId}] De ${fromRole}: ${message}`);
  
  return {
    status: 'success',
    message: 'Mensaje entregado de forma segura.'
  };
}
