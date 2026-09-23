import { Client } from 'pg';

/**
 * Fórmula de Haversine en SQL para calcular distancias en kilómetros.
 * Útil para encontrar el comercio más cercano a una coordenada dada (ej. a 500 metros).
 */
export async function find_nearest_merchant(
  courierLat: number, 
  courierLng: number, 
  keywords: string[], 
  maxDistanceKm: number = 0.5 // 500 metros por defecto
) {
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'fonsi_user',
    password: process.env.DB_PASSWORD || 'fonsi_password',
    database: process.env.DB_NAME || 'en_un_2x3'
  });

  await client.connect();

  try {
    // Usamos el operador ILIKE para buscar en las categorías o en la especialidad (ej: licor, cigarrillos, farmacia)
    const keywordFilters = keywords.map(k => \`('%' || '\${k}' || '%')\`).join(' OR category::text ILIKE ');

    const query = \`
      SELECT 
        id, name, lat, lng,
        (
          6371 * acos(
            cos(radians($1)) * cos(radians(lat)) *
            cos(radians(lng) - radians($2)) +
            sin(radians($1)) * sin(radians(lat))
          )
        ) AS distance_km
      FROM merchants
      WHERE (specialty ILIKE \${keywordFilters} OR category::text ILIKE \${keywordFilters})
        AND lat IS NOT NULL 
        AND lng IS NOT NULL
      HAVING (
        6371 * acos(
          cos(radians($1)) * cos(radians(lat)) *
          cos(radians(lng) - radians($2)) +
          sin(radians($1)) * sin(radians(lat))
        )
      ) <= $3
      ORDER BY distance_km ASC
      LIMIT 1;
    \`;

    // Nota: El HAVING en PostgreSQL a veces requiere subconsultas, 
    // pero para fines de este script adaptaremos la lógica a una CTE (Common Table Expression).
    
    const safeQuery = \`
      WITH distances AS (
        SELECT 
          id, name, lat, lng,
          (6371 * acos(cos(radians($1)) * cos(radians(lat)) * cos(radians(lng) - radians($2)) + sin(radians($1)) * sin(radians(lat)))) AS distance_km
        FROM merchants
        WHERE specialty ILIKE ANY($4) OR category::text ILIKE ANY($4)
      )
      SELECT * FROM distances WHERE distance_km <= $3 ORDER BY distance_km ASC LIMIT 1;
    \`;

    const searchArray = keywords.map(k => \`%\${k}%\`);
    const res = await client.query(safeQuery, [courierLat, courierLng, maxDistanceKm, searchArray]);

    if (res.rows.length === 0) {
      return {
        status: 'not_found',
        message: 'No se encontraron comercios abiertos con esos productos en un radio de 500 metros.'
      };
    }

    const merchant = res.rows[0];
    
    // Generar enlaces universales de navegación para el mapa de la App de la moto
    const gmapsLink = \`https://www.google.com/maps/dir/?api=1&origin=\${courierLat},\${courierLng}&destination=\${merchant.lat},\${merchant.lng}\`;
    
    return {
      status: 'success',
      merchant: merchant.name,
      distance_meters: Math.round(merchant.distance_km * 1000),
      navigation_link: gmapsLink
    };

  } catch (err: any) {
    return { status: 'error', error: err.message };
  } finally {
    await client.end();
  }
}
