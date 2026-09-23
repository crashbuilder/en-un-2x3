import { Client } from 'pg';

/**
 * Cierra un contrato de publicidad y actualiza el estado del comercio.
 */
export async function ad_close(merchantId: string, merchantName: string, planId: string, price: number) {
  const client = new Client({
    host: process.env.DB_HOST || 'postgres',
    user: process.env.DB_USER || 'fonsi_user',
    password: process.env.DB_PASSWORD || 'fonsi_password',
    database: process.env.DB_NAME || 'en_un_2x3'
  });

  await client.connect();

  try {
    await client.query('BEGIN');
    
    // 1. Insertar contrato
    await client.query(
      'INSERT INTO ad_contracts (merchant_name, plan, price_monthly) VALUES ($1, $2, $3)',
      [merchantName, planId, price]
    );

    // 2. Actualizar comercio para que salga de primero (sponsored)
    if (planId === 'destacado' || planId === 'premium') {
      await client.query(
        "UPDATE merchants SET sponsored = true, ad_plan = $1 WHERE id::text = $2 OR name ILIKE $3",
        [planId, merchantId, `%${merchantName}%`]
      );
    }

    // 3. Asiento contable de ingreso por publicidad
    await client.query(
      'INSERT INTO ledger (account, debit, credit, memo) VALUES ($1, $2, 0, $3)',
      ['banco_empresa', price, `Cobro pauta publicitaria plan ${planId} - ${merchantName}`]
    );
    await client.query(
      'INSERT INTO ledger (account, debit, credit, memo) VALUES ($1, 0, $2, $3)',
      ['ingreso_publicidad', price, `Ingreso pauta publicitaria plan ${planId} - ${merchantName}`]
    );

    await client.query('COMMIT');
    
    return {
      status: 'success',
      merchant_name: merchantName,
      plan: planId,
      price,
      message: '¡Negocio cerrado! Contrato registrado. A partir de hoy el comercio se destacará y saldrá en estados.'
    };

  } catch (err: any) {
    await client.query('ROLLBACK');
    return { status: 'error', error: err.message };
  } finally {
    await client.end();
  }
}
