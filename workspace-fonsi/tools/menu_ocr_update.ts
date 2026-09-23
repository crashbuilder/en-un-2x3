import { Client } from 'pg';

interface MenuItem {
  item: string;
  price: number;
  prep_min: number;
  available: boolean;
  type?: 'fijo' | 'diario';
}

/**
 * Herramienta para actualizar el menú del día de un restaurante.
 * Recibe los platos detectados por la Inteligencia Artificial (Visión) desde la foto enviada por el comercio.
 */
export async function menu_ocr_update(merchantId: string, dailyItems: { item: string, price: number }[]) {
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'fonsi_user',
    password: process.env.DB_PASSWORD || 'fonsi_password',
    database: process.env.DB_NAME || 'en_un_2x3'
  });

  await client.connect();

  try {
    // 1. Traer el menú actual del comercio (historial)
    const res = await client.query("SELECT menu FROM merchants WHERE id = $1 OR name = $2", [merchantId, merchantId]);
    if (res.rows.length === 0) return { status: 'error', message: 'Comercio no encontrado' };

    let currentMenu: MenuItem[] = res.rows[0].menu || [];

    // 2. Apagar todos los platos diarios actuales (pasarlos a false)
    currentMenu = currentMenu.map(plato => {
      if (plato.type === 'diario' || !plato.type) {
        return { ...plato, available: false };
      }
      return plato; // Los 'fijo' se quedan igual
    });

    // 3. Procesar los nuevos platos del día leídos de la foto
    for (const newItem of dailyItems) {
      // Buscar si el plato ya existe en el historial (ignorando mayúsculas)
      const existingIndex = currentMenu.findIndex(
        p => p.item.toLowerCase().includes(newItem.item.toLowerCase())
      );

      if (existingIndex >= 0) {
        // Reactivar plato histórico y actualizar precio
        currentMenu[existingIndex].available = true;
        currentMenu[existingIndex].price = newItem.price;
        currentMenu[existingIndex].type = 'diario';
      } else {
        // Crear plato nuevo en el catálogo
        currentMenu.push({
          item: newItem.item,
          price: newItem.price,
          prep_min: 15, // Por defecto
          available: true,
          type: 'diario'
        });
      }
    }

    // 4. Guardar el nuevo menú inteligente en la base de datos
    await client.query("UPDATE merchants SET menu = $1::jsonb WHERE id = $2 OR name = $3", [JSON.stringify(currentMenu), merchantId, merchantId]);

    return {
      status: 'success',
      message: `Menú del día actualizado. ${dailyItems.length} platos activos listos para vender.`,
      active_menu: currentMenu.filter(p => p.available)
    };

  } catch (err: any) {
    return { status: 'error', error: err.message };
  } finally {
    await client.end();
  }
}
