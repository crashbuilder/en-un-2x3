import { Client } from 'pg';

/**
 * Valida un comprobante contra una orden y marca como verificado.
 */
export async function payment_verify(orderId: string, ocrData: any, imageUrl?: string) {
  const client = new Client({
    host: process.env.DB_HOST || 'postgres',
    user: process.env.DB_USER || 'fonsi_user',
    password: process.env.DB_PASSWORD || 'fonsi_password',
    database: process.env.DB_NAME || 'en_un_2x3'
  });

  await client.connect();

  try {
    const res = await client.query('SELECT id, code, total, subtotal, delivery_fee, status, payment_status FROM orders WHERE code = $1 OR id::text = $1', [orderId]);
    if (res.rows.length === 0) return { status: 'error', error: 'Order not found' };
    
    const order = res.rows[0];
    const expectedAmount = Number(order.total);
    const receivedAmount = Number(ocrData.amount);
    
    // 1. Validar si la referencia ya fue usada previamente (Anti-fraude de comprobante reciclado)
    const refCheck = await client.query('SELECT id FROM receipts WHERE ocr_ref = $1', [ocrData.reference]);
    if (refCheck.rows.length > 0) {
      await client.query("UPDATE orders SET payment_status = 'REVIEW' WHERE id = $1", [order.id]);
      return {
        status: 'failed',
        verified: false,
        error: '⚠️ Referencia de comprobante duplicada. Comprobante ya utilizado previamente.'
      };
    }

    // 2. Tolerancia de valor +- $500 COP
    const amountMatch = Math.abs(receivedAmount - expectedAmount) <= 500;
    
    // 3. Insertar en tabla receipts
    await client.query(`
      INSERT INTO receipts (
        order_id, image_url, ocr_amount, ocr_date, ocr_wallet, 
        ocr_ref, ocr_destination, match_ok, raw_ocr
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      order.id, imageUrl || '', receivedAmount, ocrData.date || new Date(), 
      ocrData.wallet || 'nequi', ocrData.reference, ocrData.destination || '3001234567',
      amountMatch, JSON.stringify(ocrData)
    ]);

    if (amountMatch) {
      await client.query("UPDATE orders SET payment_status = 'VERIFIED', status = 'PREPARING', transfer_part = $1 WHERE id = $2", [receivedAmount, order.id]);
      return { 
        status: 'success', 
        verified: true, 
        order_code: order.code,
        amount: receivedAmount,
        reference: ocrData.reference,
        message: '✅ Pago verificado correctamente. Tu pedido pasa a preparación.' 
      };
    } else {
      await client.query("UPDATE orders SET payment_status = 'REVIEW' WHERE id = $1", [order.id]);
      return { 
        status: 'failed', 
        verified: false, 
        order_code: order.code,
        expected: expectedAmount,
        received: receivedAmount,
        error: `El valor transferido ($${receivedAmount.toLocaleString('es-CO')}) no coincide con el total del pedido ($${expectedAmount.toLocaleString('es-CO')}). Pasando a revisión.` 
      };
    }
  } catch (err: any) {
    console.error("Error en payment_verify:", err);
    return { status: 'error', error: err.message };
  } finally {
    await client.end();
  }
}

