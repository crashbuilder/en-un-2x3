import { Telegraf, Markup } from 'telegraf';
import OpenAI from 'openai';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

console.log('Iniciando el núcleo de Fonsi (Refactorizado)...');

const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
  console.warn('⚠️ No se encontró TELEGRAM_BOT_TOKEN. Saliendo...');
  process.exit(1);
}
const bot = new Telegraf(botToken);

const openai = new OpenAI({ 
  apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || 'sk-FAKE-KEY',
  baseURL: process.env.LLM_BASE_URL || 'https://api.openai.com/v1'
});

// 1. Usar el alma real
let fonsiSoul = "Eres Fonsi. Responde corto.";
try {
  fonsiSoul = fs.readFileSync('/workspace/SOUL.md', 'utf8');
} catch (e) {
  try {
    fonsiSoul = fs.readFileSync(path.join(__dirname, '../workspace-fonsi/SOUL.md'), 'utf8');
  } catch (e2) {
    console.warn("No se pudo leer SOUL.md de ninguna ruta");
  }
}

// 4. Expiración de sesiones (TTL) y tipado
interface SessionData {
  history: any[];
  lastActivity: number;
}
const userSessions = new Map<string, SessionData>();
const SESSION_TTL = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [userId, session] of userSessions.entries()) {
    if (now - session.lastActivity > SESSION_TTL) {
      userSessions.delete(userId);
    }
  }
}, 5 * 60 * 1000);

const sendWelcome = async (ctx: any) => {
    const userId = ctx.from.id.toString();
    userSessions.set(userId, { history: [], lastActivity: Date.now() });
    
    await ctx.reply(
        '¡Hola! 🛵 ¿Qué servicio necesitas hoy? ¡Dime y te lo solucionaré en UN 2x3! 🚀😎',
        Markup.inlineKeyboard([
            [Markup.button.callback('🛵 Pedir Mototaxi', 'btn_mototaxi')],
            [Markup.button.callback('📦 Pedir Domicilio', 'btn_domicilio')]
        ])
    );
};

bot.start(sendWelcome);

bot.action('btn_mototaxi', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('¡En un 2x3 estará llegando tu mototaxi! 🛵💨 (Calculando tiempo estimado de llegada por tu zona...)');
});

bot.action('btn_domicilio', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    if (!userSessions.has(userId)) userSessions.set(userId, { history: [], lastActivity: Date.now() });
    const session = userSessions.get(userId)!;
    
    // Inject the simulated message so LLM thinks the user asked for a general delivery
    session.history.push({ role: 'user', content: 'quiero pedir un domicilio' });
    
    await ctx.reply('¡Claro que sí! 📦 ¿Qué te llevamos hoy? Puede ser comida, hacer un mandado a la tienda, medicinas o lo que necesites. ¡Dime qué buscas!');
});

import { Client } from 'pg';

const dbClient = new Client({
  host: process.env.DB_HOST || 'postgres',
  user: process.env.DB_USER || 'fonsi_user',
  password: process.env.DB_PASSWORD || 'fonsi_password',
  database: process.env.DB_NAME || 'en_un_2x3',
});
dbClient.connect().catch(e => console.error("Error DB:", e));

const toolsBasePath = fs.existsSync('/workspace/tools') 
  ? '/workspace/tools' 
  : path.join(__dirname, '../workspace-fonsi/tools');

const { receipt_ocr } = require(path.join(toolsBasePath, 'receipt_ocr'));
const { payment_verify } = require(path.join(toolsBasePath, 'payment_verify'));
const { ledger_post } = require(path.join(toolsBasePath, 'ledger_post'));
const { courier_settle } = require(path.join(toolsBasePath, 'courier_settle'));
const { fare_quote } = require(path.join(toolsBasePath, 'fare_quote'));
const { eta_calculate } = require(path.join(toolsBasePath, 'eta_calculate'));
const { relay_message } = require(path.join(toolsBasePath, 'relay_message'));
const { ad_pitch } = require(path.join(toolsBasePath, 'ad_pitch'));
const { ad_close } = require(path.join(toolsBasePath, 'ad_close'));
const { status_publish } = require(path.join(toolsBasePath, 'status_publish'));
const { merchant_list } = require(path.join(toolsBasePath, 'merchant_list'));

// Helper para crear orden y asignar mensajero
async function processOrderCreation(userId: string, userName: string, orderData: any) {
  try {
    // 1. Asegurar usuario en tabla users
    const userRes = await dbClient.query(`
      INSERT INTO users (wa_phone, name, default_address, payment_pref)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (wa_phone) DO UPDATE 
      SET name = EXCLUDED.name, default_address = COALESCE(EXCLUDED.default_address, users.default_address)
      RETURNING id
    `, [userId, userName || 'Cliente Telegram', orderData.destination || 'Fonseca', orderData.payment_method || 'cash']);
    const userDbId = userRes.rows[0].id;

    // 2. Buscar merchant_id
    let merchantDbId = null;
    if (orderData.merchant) {
      const mRes = await dbClient.query(
        "SELECT id, name FROM merchants WHERE name ILIKE $1 LIMIT 1",
        [`%${orderData.merchant}%`]
      );
      if (mRes.rows.length > 0) merchantDbId = mRes.rows[0].id;
    }

    // 3. Generar código único FX-####
    const randomCode = `FX-${Math.floor(1000 + Math.random() * 9000)}`;
    const subtotal = Number(orderData.subtotal) || 0;
    const deliveryFee = Number(orderData.delivery_fee) || 3000;
    const total = subtotal + deliveryFee;
    const paymentMethod = orderData.payment_method || 'cash';
    const orderType = orderData.type || 'food';
    const destination = { label: orderData.destination || 'Fonseca' };
    const origin = orderData.origin ? { label: orderData.origin } : null;
    const items = orderData.items || [];
    
    // Si es transferencia, estado inicial DRAFT; si es efectivo, CONFIRMED
    const initialStatus = paymentMethod === 'transfer' ? 'DRAFT' : 'CONFIRMED';

    const orderRes = await dbClient.query(`
      INSERT INTO orders (
        code, type, user_id, merchant_id, status, items,
        subtotal, delivery_fee, total, payment_method, payment_status,
        origin, destination, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, 'PENDING',
        $11, $12, now()
      ) RETURNING id, code, status
    `, [
      randomCode, orderType, userDbId, merchantDbId, initialStatus, JSON.stringify(items),
      subtotal, deliveryFee, total, paymentMethod, JSON.stringify(origin), JSON.stringify(destination)
    ]);

    const createdOrder = orderRes.rows[0];

    // 4. Asignar mensajero disponible (dispatch_assign)
    const courierRes = await dbClient.query(
      "SELECT id, name, vehicle, plate FROM couriers WHERE is_active = true ORDER BY RANDOM() LIMIT 1"
    );

    let courierInfo = null;
    if (courierRes.rows.length > 0) {
      courierInfo = courierRes.rows[0];
      const assignedStatus = paymentMethod === 'transfer' ? 'DRAFT' : 'ON_THE_WAY';
      await dbClient.query(
        "UPDATE orders SET courier_id = $1, status = $2 WHERE id = $3",
        [courierInfo.id, assignedStatus, createdOrder.id]
      );
    }

    return {
      success: true,
      code: createdOrder.code,
      type: orderType,
      total,
      deliveryFee,
      paymentMethod,
      courier: courierInfo
    };
  } catch (err: any) {
    console.error("Error creating order:", err);
    return { success: false, error: err.message };
  }
}

// Manejador de fotos de comprobantes de pago (Nequi / Daviplata / Bre-B)
bot.on('photo', async (ctx) => {
  const userId = ctx.from.id.toString();
  await ctx.sendChatAction('typing').catch(e => console.error(e));

  try {
    const orderRes = await dbClient.query(`
      SELECT o.id, o.code, o.total, o.payment_method, o.status, o.payment_status
      FROM orders o
      JOIN users u ON o.user_id = u.id
      WHERE u.wa_phone = $1
      ORDER BY o.created_at DESC LIMIT 1
    `, [userId]);

    if (orderRes.rows.length === 0) {
      return ctx.reply('📸 Recibí tu foto, pero no tienes ningún pedido pendiente de pago en este momento. Si deseas pedir algo, ¡dime y te lo llevo en un 2x3! 🛵');
    }

    const order = orderRes.rows[0];
    const photos = ctx.message.photo;
    const bestPhoto = photos[photos.length - 1];
    const fileLink = await ctx.telegram.getFileLink(bestPhoto.file_id);
    const imageUrl = fileLink.href;

    await ctx.reply('🔍 Analizando tu comprobante de pago con visión IA... dame un segundito.');

    const ocrResult = await receipt_ocr(imageUrl, Number(order.total));
    const verifyResult = await payment_verify(order.code, ocrResult.data, imageUrl);

    if (verifyResult.verified) {
      let msg = `✅ **¡Comprobante Verificado con Éxito!**\n\n`;
      msg += `📋 Pedido: **${verifyResult.order_code}**\n`;
      msg += `💰 Valor: **$${Number(verifyResult.amount).toLocaleString('es-CO')} COP**\n`;
      msg += `🔖 Referencia: \`${verifyResult.reference}\`\n`;
      msg += `🏦 Billetera: **${ocrResult.data.wallet.toUpperCase()}**\n\n`;
      msg += `🍳 Tu pedido ha pasado a **PREPARACIÓN** y el mensajero ya está notificado. ¡Te lo llevamos en un 2x3! 🚀`;
      await ctx.reply(msg);
    } else {
      let msg = `⚠️ **Atención con tu comprobante:**\n\n`;
      msg += `${verifyResult.error || 'No pudimos validar automáticamente el comprobante.'}\n\n`;
      msg += `Hemos notificado al equipo de soporte para verificación manual.`;
      await ctx.reply(msg);
    }
  } catch (err: any) {
    console.error("Error procesando foto de comprobante:", err);
    await ctx.reply('Tuvimos un inconveniente leyendo la foto. Por favor asegúrate que la imagen sea clara o escribe al administrador.');
  }
});

// Comando /pedido o /status para consultar estado en vivo
bot.command(['pedido', 'status'], async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const res = await dbClient.query(`
      SELECT o.code, o.type, o.status, o.payment_status, o.total, o.payment_method, o.created_at, c.name as courier_name, c.plate
      FROM orders o
      JOIN users u ON o.user_id = u.id
      LEFT JOIN couriers c ON o.courier_id = c.id
      WHERE u.wa_phone = $1
      ORDER BY o.created_at DESC LIMIT 1
    `, [userId]);

    if (res.rows.length === 0) {
      return ctx.reply('No tienes ningún pedido o viaje activo en este momento. Escríbeme qué necesitas para llevártelo en un 2x3 🛵');
    }

    const order = res.rows[0];
    const statusMap: any = {
      'DRAFT': '📝 Registrado (Pendiente pago)',
      'CONFIRMED': '✅ Confirmado',
      'PREPARING': '🍳 En preparación',
      'ON_THE_WAY': '🛵 En camino',
      'DELIVERED': '🎉 Entregado / Completado',
      'CANCELLED': '❌ Cancelado'
    };

    let msg = `📋 **Estado de tu Servicio [${order.code}]**\n`;
    msg += `• Tipo: ${order.type === 'ride' ? '🛵 Mototaxi/Viaje' : order.type === 'package' ? '📦 Mandado' : '🍔 Domicilio'}\n`;
    msg += `• Estado: ${statusMap[order.status] || order.status}\n`;
    msg += `• Pago: ${order.payment_method === 'cash' ? '💵 Efectivo' : '📱 Transferencia'} (${order.payment_status === 'VERIFIED' ? '✅ Verificado' : '⏳ Pendiente'})\n`;
    msg += `• Total: $${Number(order.total).toLocaleString('es-CO')} COP\n`;
    if (order.courier_name) {
      msg += `• Conductor/Mensajero: ${order.courier_name} (${order.plate || 'Moto'})\n`;
    }
    await ctx.reply(msg);
  } catch (err: any) {
    await ctx.reply('Error al consultar tu pedido.');
  }
});

// Comando /mototaxi o /viaje (Fase 3)
bot.command(['mototaxi', 'viaje'], async (ctx) => {
  const quoteMoto = await fare_quote('ride', 'moto');
  const quoteCar = await fare_quote('ride', 'carro');
  
  let msg = `🛵 **Servicio de Transporte y Mototaxi ("En un 2x3")**\n\n`;
  msg += `Tarifas urbanas en Fonseca:\n`;
  msg += `• 🏍️ **Mototaxi:** $${quoteMoto.fee.toLocaleString('es-CO')} COP (Llega en ${quoteMoto.pickup_eta})\n`;
  msg += `• 🚗 **Carro:** $${quoteCar.fee.toLocaleString('es-CO')} COP (Llega en ${quoteCar.pickup_eta})\n\n`;
  msg += `📍 *¿Desde dónde te recogemos y para dónde vas?* (Escríbeme o comparte tu ubicación).`;
  await ctx.reply(msg);
});

// Comando /mandado (Fase 3)
bot.command('mandado', async (ctx) => {
  const quote = await fare_quote('package');
  let msg = `📦 **Mandados Libres ("De lo que sea")**\n\n`;
  msg += `Tarifa plana urbana: **$${quote.fee.toLocaleString('es-CO')} COP** (hasta 5 kg)\n`;
  msg += `⏱️ Tiempo estimado: **${quote.eta_range}**\n\n`;
  msg += `Dime qué necesitas traer o llevar (farmacia, documentos, compras de la plaza, llaves) y las direcciones de recogida y entrega.`;
  await ctx.reply(msg);
});

// Comando /relay para hablar con el mensajero sin exponer números (Fase 3)
bot.command('relay', async (ctx) => {
  const userId = ctx.from.id.toString();
  const text = ctx.message.text.replace('/relay', '').trim();
  if (!text) {
    return ctx.reply('Escribe tu mensaje para el mensajero. Ejemplo: `/relay ya estoy en el portón`');
  }

  const orderRes = await dbClient.query(`
    SELECT o.id, o.code, c.name as courier_name
    FROM orders o
    JOIN users u ON o.user_id = u.id
    LEFT JOIN couriers c ON o.courier_id = c.id
    WHERE u.wa_phone = $1 AND o.status IN ('CONFIRMED', 'PREPARING', 'ON_THE_WAY')
    ORDER BY o.created_at DESC LIMIT 1
  `, [userId]);

  if (orderRes.rows.length === 0) {
    return ctx.reply('No tienes ningún servicio activo en curso para contactar al mensajero.');
  }

  const order = orderRes.rows[0];
  await relay_message(order.id, 'user', text);
  await ctx.reply(`🔒 **Mensaje entregado a ${order.courier_name || 'tu mensajero'}:**\n"${text}"\n*(Tus números permanecen 100% privados)*`);
});

// Comando /publicidad o /anunciar (Fase 4)
bot.command(['publicidad', 'anunciar', 'pauta'], async (ctx) => {
  const pitch = await ad_pitch();
  let msg = `📢 **Planes de Publicidad para Comercios Aliados ("En un 2x3")**\n\n`;
  pitch.plans.forEach(p => {
    msg += `• **${p.name}:** $${p.price.toLocaleString('es-CO')}/mes\n  ${p.description}\n\n`;
  });
  msg += `💼 Si deseas activar tu pauta hoy, dime el nombre de tu comercio y el plan que prefieres.`;
  await ctx.reply(msg);
});

// Comando /estado (Fase 4)
bot.command('estado', async (ctx) => {
  const pub = await status_publish();
  await ctx.reply(`📢 ${pub.message}\n🌟 Aliados destacados del día publicados en el canal.`);
});

// Comando /entregar [codigo] para simular entrega (DELIVERED) y generar asiento contable
bot.command('entregar', async (ctx) => {
  const args = ctx.message.text.split(' ');
  const code = args[1]?.toUpperCase().trim();
  if (!code) {
    return ctx.reply('Indica el código del pedido. Ejemplo: `/entregar FX-1234`');
  }

  try {
    const res = await dbClient.query(
      "UPDATE orders SET status = 'DELIVERED', delivered_at = now() WHERE code = $1 RETURNING id, code, status, total, payment_method",
      [code]
    );
    if (res.rowCount === 0) {
      return ctx.reply(`No se encontró ningún pedido con código ${code}`);
    }
    
    const order = res.rows[0];
    const ledgerResult = await ledger_post(order.id);

    let reply = `🎉 Pedido **${code}** marcado como **DELIVERED** (Entregado con éxito).\n\n`;
    if (ledgerResult.status === 'success') {
      reply += `📖 **Asiento Contable Registrado:**\n`;
      reply += `• Débitos: $${ledgerResult.total_debit?.toLocaleString('es-CO')} COP\n`;
      reply += `• Créditos: $${ledgerResult.total_credit?.toLocaleString('es-CO')} COP\n`;
      reply += `• Estado: ✅ Balance Cuadrado (Partida Doble)`;
    }
    await ctx.reply(reply);
  } catch (err: any) {
    console.error("Error en comando entregar:", err);
    await ctx.reply('Error al actualizar el estado del pedido.');
  }
});

// Comando /liquidar o /cierre para ver la liquidación diaria de mensajeros y cuadre de caja
bot.command(['liquidar', 'cierre'], async (ctx) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const couriersRes = await dbClient.query("SELECT id, name, plate FROM couriers WHERE is_active = true");
    
    let summaryMsg = `🧾 **CIERRE Y LIQUIDACIÓN DIARIA (${today})**\n\n`;
    let grandTotalCash = 0;
    let grandTotalFees = 0;
    let grandNet = 0;

    for (const courier of couriersRes.rows) {
      const res = await courier_settle(courier.id, today);
      if (res.status === 'success') {
        const s = res.settlement;
        grandTotalCash += s.cash_collected;
        grandTotalFees += s.fees_earned;
        grandNet += s.net_to_consign;

        summaryMsg += `🏍️ **${courier.name}** (${courier.plate || 'Moto'}):\n`;
        summaryMsg += `  • Servicios entregados: ${s.services}\n`;
        summaryMsg += `  • Efectivo recibido: $${s.cash_collected.toLocaleString('es-CO')} COP\n`;
        summaryMsg += `  • Domicilios ganados: $${s.fees_earned.toLocaleString('es-CO')} COP\n`;
        summaryMsg += `  • 💵 **A consignar a la empresa:** $${s.net_to_consign.toLocaleString('es-CO')} COP\n\n`;
      }
    }

    summaryMsg += `━━━━━━━━━━━━━━━━━━\n`;
    summaryMsg += `💰 **TOTAL RECAUDADO:** $${grandTotalCash.toLocaleString('es-CO')} COP\n`;
    summaryMsg += `🛵 **TOTAL GANANCIA MENSAJEROS:** $${grandTotalFees.toLocaleString('es-CO')} COP\n`;
    summaryMsg += `🏦 **NETO A RECIBIR EN CAJA:** $${grandNet.toLocaleString('es-CO')} COP`;

    await ctx.reply(summaryMsg);
  } catch (err: any) {
    console.error("Error en liquidar:", err);
    await ctx.reply('Error al generar la liquidación.');
  }
});

bot.on('text', async (ctx, next) => {
  const userMessage = ctx.message.text;
  const userId = ctx.from.id.toString();
  const userName = ctx.from.first_name || 'Cliente';
  
  if (userMessage.trim().toLowerCase() === 'hola') {
      return sendWelcome(ctx);
  }

  console.log(`\n[TELEGRAM] Mensaje de ${userId} (${userName}): ${userMessage}`);
  await ctx.sendChatAction('typing').catch(e => console.error('Error typing:', e));

  if (!userSessions.has(userId)) {
     userSessions.set(userId, { history: [], lastActivity: Date.now() });
  }
  const session = userSessions.get(userId)!;
  session.lastActivity = Date.now();
  
  let greetingRule = "";
  if (session.history.length === 0) {
    greetingRule = `\nREGLA: Este es el primer mensaje. DEBES responder obligatoriamente con el saludo exacto: "¡Hola! 🛵 ¿Qué domicilio vas a pedir? Comida, mandados o hasta tu mototaxi... ¡Dime y te lo llevaré en UN 2x3! 🚀😎"`;
  }

  session.history.push({ role: 'user', content: userMessage });
  if (session.history.length > 8) session.history.splice(0, session.history.length - 8);

  // Consultar DB en vivo con comercios patrocinados primero
  let dbContext = "Catálogo temporal";
  try {
    const dbRes = await dbClient.query("SELECT name, specialty, menu, sponsored, ad_plan FROM merchants ORDER BY sponsored DESC, name ASC");
    dbContext = JSON.stringify(dbRes.rows);
  } catch (err) {
    console.error("Fallo DB", err);
  }

  const promptAntiRobot = `
REGLAS VITALES DE ATENCIÓN AL CLIENTE (Fases 1, 2, 3 y 4):

1. MODO CATÁLOGO (Si el usuario pide menú):
   - Envía el menú organizado destacando a los "🌟 Aliados Destacados" primero.

2. MODO MANDADOS Y MOTOTAXIS (Fase 3):
   - Si piden carrera de mototaxi: tarifa fija $4.000 (moto) o $8.000 (carro) en Fonseca. Comunica ETA en rango (3-10 min).
   - Si piden mandado libre: tarifa base $6.000 hasta 5kg.

3. PUBLICIDAD A COMERCIOS (Fase 4):
   - Si un comercio quiere pautar o anunciarse: ofrece los planes: 🌟 Destacado ($80.000/mes), 📢 Estado ($50.000/mes), 💎 Premium ($110.000/mes).
   - Si confirman pauta, añade al final: <<<AD_CLOSE:{"merchant":"Nombre","plan":"destacado|estado|premium","price":80000}>>>

4. CONFIRMACIÓN Y REGISTRO AUTOMÁTICO DE PEDIDO/VIAJE:
   - Cuando el cliente confirme su pedido o viaje, DEBES incluir AL FINAL de tu respuesta el tag especial:
     <<<ORDER_CREATE:{"type":"food"|"ride"|"package","merchant":"Nombre Comercio","items":[{"item":"Detalle","qty":1,"price":15000}],"subtotal":15000,"delivery_fee":3000,"payment_method":"cash"|"transfer","destination":"Dirección/Barrio"}>>>`;

  const fullSystemPrompt = `${fonsiSoul}\n\n=== BASE DE DATOS EN VIVO ===\nA continuación tienes los comercios y menús actuales (aliados con 🌟 primero):\n${dbContext}\n\n${promptAntiRobot}${greetingRule}`;

  let retries = 0;
  let success = false;
  const primaryModel = process.env.LLM_MODEL || 'gemini-2.5-flash';
  const fallbackModels = [primaryModel, 'gemini-2.5-flash-lite', 'gemini-2.5-flash'];

  while (retries < 4 && !success) {
    const currentModel = fallbackModels[retries] || primaryModel;
    try {
      console.log(`-> Intento ${retries + 1} (${currentModel})... Llamando a LLM...`);

      const reqBody = {
        model: currentModel,
        messages: [
          { role: 'system', content: fullSystemPrompt },
          ...session.history
        ],
        temperature: 0.7
      };

      const response = await Promise.race([
        fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.LLM_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(reqBody)
        }).then(async (r) => {
          const json = await r.json();
          if (!r.ok || json.error) {
            const err: any = new Error(json.error?.message || r.statusText);
            err.status = json.error?.code || r.status;
            throw err;
          }
          return json;
        }),
        new Promise<any>((_, reject) => setTimeout(() => reject(new Error('timeout_google_api')), 25000))
      ]);

      let fonsiReply = response.choices?.[0]?.message?.content || 'Mmm, me quedé sin palabras.';
      
      // Detectar y procesar tag <<<ORDER_CREATE:...>>>
      const orderTagMatch = fonsiReply.match(/<<<ORDER_CREATE:(.*?)>>>/s);
      if (orderTagMatch) {
        try {
          const orderJson = JSON.parse(orderTagMatch[1]);
          const orderResult = await processOrderCreation(userId, userName, orderJson);
          fonsiReply = fonsiReply.replace(/<<<ORDER_CREATE:(.*?)>>>/s, '').trim();
          
          if (orderResult.success) {
            fonsiReply += `\n\n🛵 **¡Servicio Registrado y Despachado!**\n`;
            fonsiReply += `📋 Código: **${orderResult.code}**\n`;
            if (orderResult.courier) {
              fonsiReply += `🏍️ Conductor/Mensajero: **${orderResult.courier.name}** (${orderResult.courier.plate || 'Moto'})\n`;
            }
            fonsiReply += `📍 Total: **$${orderResult.total.toLocaleString('es-CO')} COP** (${orderResult.paymentMethod === 'cash' ? 'Efectivo' : 'Transferencia'})\n`;
            fonsiReply += `⚡ *¡Te lo llevamos en un 2x3!*`;
          }
        } catch (e) {
          console.error("Error parseando ORDER_CREATE tag:", e);
        }
      }

      // Detectar y procesar tag <<<AD_CLOSE:...>>>
      const adTagMatch = fonsiReply.match(/<<<AD_CLOSE:(.*?)>>>/s);
      if (adTagMatch) {
        try {
          const adJson = JSON.parse(adTagMatch[1]);
          await ad_close('', adJson.merchant || 'Comercio', adJson.plan || 'destacado', Number(adJson.price) || 80000);
          fonsiReply = fonsiReply.replace(/<<<AD_CLOSE:(.*?)>>>/s, '').trim();
          fonsiReply += `\n\n🤝 **¡Contrato de Publicidad Activado!**\n🌟 A partir de hoy tu comercio sale destacado con sello oficial en Fonsi.`;
        } catch (e) {
          console.error("Error parseando AD_CLOSE tag:", e);
        }
      }

      session.history.push({ role: 'assistant', content: fonsiReply });
      
      const chunkSize = 4000;
      for (let i = 0; i < fonsiReply.length; i += chunkSize) {
        await ctx.reply(fonsiReply.substring(i, i + chunkSize)).catch(e => console.error('Error replying:', e));
      }
      success = true;

    } catch (error: any) {
      console.error(`[DEBUG LLM ERROR]:`, error.status || error.code, error.message);
      const errMsg = (error.message || '').toLowerCase();
      const isRetryable = 
        error.status === 429 || 
        error.status >= 500 || 
        error.code === 'ECONNRESET' || 
        error.code === 'ETIMEDOUT' ||
        errMsg.includes('timeout') ||
        errMsg.includes('fetch failed') ||
        errMsg.includes('service unavailable');

      if (isRetryable && retries < 3) {
        retries++;
        const backoff = Math.min(Math.pow(1.5, retries) * 1000, 4000);
        await new Promise(resolve => setTimeout(resolve, backoff));
      } else if (retries >= 3) {
        await ctx.reply('¡Qué pena contigo! En este instante tenemos muchos pedidos en fila. ¿Me regalas un par de minuticos y me vuelves a escribir?');
        break;
      } else {
        retries++;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
});

// ==========================================
// FASE 5: SERVIDOR HTTP Y PANEL WEB ADMIN
// ==========================================
import * as http from 'http';

const adminServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = req.url || '/';

  // API Endpoints
  if (url === '/api/stats') {
    try {
      const ordersCount = await dbClient.query("SELECT count(*) as total, count(*) FILTER (WHERE status = 'DELIVERED') as delivered, sum(total) as revenue FROM orders");
      const ledgerSum = await dbClient.query("SELECT sum(debit) as total_volume FROM ledger");
      const couriersCount = await dbClient.query("SELECT count(*) as total FROM couriers WHERE is_active = true");
      const merchantsCount = await dbClient.query("SELECT count(*) as total, count(*) FILTER (WHERE sponsored = true) as sponsored FROM merchants");

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        orders: ordersCount.rows[0],
        ledger_volume: ledgerSum.rows[0]?.total_volume || 0,
        couriers: couriersCount.rows[0]?.total || 0,
        merchants: merchantsCount.rows[0]
      }));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (url === '/api/orders') {
    try {
      const orders = await dbClient.query(`
        SELECT o.*, u.name as user_name, u.wa_phone as user_phone, c.name as courier_name, c.plate as courier_plate, m.name as merchant_name
        FROM orders o
        LEFT JOIN users u ON o.user_id = u.id
        LEFT JOIN couriers c ON o.courier_id = c.id
        LEFT JOIN merchants m ON o.merchant_id = m.id
        ORDER BY o.created_at DESC LIMIT 50
      `);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(orders.rows));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (url === '/api/ledger') {
    try {
      const ledger = await dbClient.query(`
        SELECT l.*, o.code as order_code 
        FROM ledger l
        LEFT JOIN orders o ON l.order_id = o.id
        ORDER BY l.id DESC LIMIT 100
      `);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(ledger.rows));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (url === '/api/settlements') {
    try {
      const settlements = await dbClient.query(`
        SELECT s.*, c.name as courier_name, c.plate
        FROM settlements s
        JOIN couriers c ON s.courier_id = c.id
        ORDER BY s.date DESC LIMIT 50
      `);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(settlements.rows));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (url === '/api/merchants') {
    try {
      const merchants = await dbClient.query("SELECT * FROM merchants ORDER BY sponsored DESC, name ASC");
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(merchants.rows));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (url === '/api/couriers') {
    try {
      const couriers = await dbClient.query("SELECT * FROM couriers ORDER BY is_active DESC, name ASC");
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(couriers.rows));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // HTML SPA Dashboard
  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>En un 2x3 — Panel de Control Administrativo</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex flex-col font-sans">
  <header class="bg-slate-900 border-b border-slate-800 px-6 py-4 flex items-center justify-between shadow-lg">
    <div class="flex items-center gap-3">
      <span class="text-3xl">🛵</span>
      <div>
        <h1 class="text-xl font-black bg-gradient-to-r from-amber-400 to-orange-500 bg-clip-text text-transparent">EN UN 2X3</h1>
        <p class="text-xs text-slate-400">Panel Operativo & Financiero — Fonseca, La Guajira</p>
      </div>
    </div>
    <div class="flex items-center gap-3">
      <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
        <span class="w-2 h-2 rounded-full bg-emerald-400 mr-2 animate-pulse"></span>
        Bot @Fonsi2x3_bot En Vivo
      </span>
      <button onclick="loadAllData()" class="px-3 py-1.5 bg-orange-600 hover:bg-orange-500 text-xs font-bold rounded-lg transition shadow">
        <i class="fa-solid fa-arrows-rotate mr-1"></i> Actualizar
      </button>
    </div>
  </header>

  <main class="flex-1 p-6 max-w-7xl w-full mx-auto space-y-6">
    <!-- KPIs -->
    <div class="grid grid-cols-1 md:grid-cols-4 gap-4" id="kpi-container">
      <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl shadow">
        <p class="text-xs text-slate-400 uppercase font-bold tracking-wider">Total Servicios</p>
        <p class="text-2xl font-black text-amber-400 mt-1" id="kpi-orders">-</p>
        <p class="text-xs text-slate-500 mt-1">Órdenes registradas</p>
      </div>
      <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl shadow">
        <p class="text-xs text-slate-400 uppercase font-bold tracking-wider">Volumen Contable</p>
        <p class="text-2xl font-black text-emerald-400 mt-1" id="kpi-revenue">-</p>
        <p class="text-xs text-slate-500 mt-1">Total transacciones</p>
      </div>
      <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl shadow">
        <p class="text-xs text-slate-400 uppercase font-bold tracking-wider">Flota Activa</p>
        <p class="text-2xl font-black text-blue-400 mt-1" id="kpi-couriers">-</p>
        <p class="text-xs text-slate-500 mt-1">Mensajeros disponibles</p>
      </div>
      <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl shadow">
        <p class="text-xs text-slate-400 uppercase font-bold tracking-wider">Aliados Comerciales</p>
        <p class="text-2xl font-black text-purple-400 mt-1" id="kpi-merchants">-</p>
        <p class="text-xs text-slate-500 mt-1">Comercios en Fonseca</p>
      </div>
    </div>

    <!-- Tabs Navigation -->
    <div class="flex border-b border-slate-800 gap-4 text-sm font-semibold">
      <button onclick="switchTab('orders')" id="tab-btn-orders" class="tab-btn py-2 border-b-2 border-orange-500 text-orange-400">
        <i class="fa-solid fa-box mr-1"></i> Pedidos en Vivo
      </button>
      <button onclick="switchTab('ledger')" id="tab-btn-ledger" class="tab-btn py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200">
        <i class="fa-solid fa-book mr-1"></i> Libro Mayor (Ledger)
      </button>
      <button onclick="switchTab('settlements')" id="tab-btn-settlements" class="tab-btn py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200">
        <i class="fa-solid fa-receipt mr-1"></i> Liquidaciones Diarias
      </button>
      <button onclick="switchTab('merchants')" id="tab-btn-merchants" class="tab-btn py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200">
        <i class="fa-solid fa-store mr-1"></i> Comercios & Pauta
      </button>
      <button onclick="switchTab('couriers')" id="tab-btn-couriers" class="tab-btn py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200">
        <i class="fa-solid fa-motorcycle mr-1"></i> Flota Mensajeros
      </button>
    </div>

    <!-- Tab Contents -->
    <div id="tab-orders" class="tab-content bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow">
      <div class="p-4 border-b border-slate-800 font-bold flex justify-between items-center">
        <span>Monitoreo de Pedidos en Vivo</span>
        <span class="text-xs text-slate-400 font-normal">Actualización automática</span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs">
          <thead class="bg-slate-950/50 text-slate-400 border-b border-slate-800">
            <tr>
              <th class="p-3">Código</th>
              <th class="p-3">Tipo</th>
              <th class="p-3">Cliente</th>
              <th class="p-3">Comercio / Detalle</th>
              <th class="p-3">Mensajero</th>
              <th class="p-3">Total</th>
              <th class="p-3">Pago</th>
              <th class="p-3">Estado</th>
            </tr>
          </thead>
          <tbody id="table-orders-body" class="divide-y divide-slate-800">
            <tr><td colspan="8" class="p-4 text-center text-slate-500">Cargando pedidos...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div id="tab-ledger" class="tab-content hidden bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow">
      <div class="p-4 border-b border-slate-800 font-bold">Libro Mayor Contable — Partida Doble Verificada</div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs">
          <thead class="bg-slate-950/50 text-slate-400 border-b border-slate-800">
            <tr>
              <th class="p-3">ID Asiento</th>
              <th class="p-3">Orden</th>
              <th class="p-3">Cuenta Contable</th>
              <th class="p-3 text-emerald-400">Débito (+)</th>
              <th class="p-3 text-orange-400">Crédito (-)</th>
              <th class="p-3">Concepto (Memo)</th>
            </tr>
          </thead>
          <tbody id="table-ledger-body" class="divide-y divide-slate-800">
            <tr><td colspan="6" class="p-4 text-center text-slate-500">Cargando libro mayor...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div id="tab-settlements" class="tab-content hidden bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow">
      <div class="p-4 border-b border-slate-800 font-bold">Liquidaciones Diarias de Mensajeros (Cierre de Caja)</div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs">
          <thead class="bg-slate-950/50 text-slate-400 border-b border-slate-800">
            <tr>
              <th class="p-3">Fecha</th>
              <th class="p-3">Mensajero</th>
              <th class="p-3">Efectivo Recogido</th>
              <th class="p-3">Tarifas Ganadas</th>
              <th class="p-3 font-bold text-amber-400">Neto a Consignar</th>
              <th class="p-3">Estado</th>
            </tr>
          </thead>
          <tbody id="table-settlements-body" class="divide-y divide-slate-800">
            <tr><td colspan="6" class="p-4 text-center text-slate-500">Cargando liquidaciones...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div id="tab-merchants" class="tab-content hidden bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow">
      <div class="p-4 border-b border-slate-800 font-bold">Comercios Aliados & Contratos de Publicidad</div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs">
          <thead class="bg-slate-950/50 text-slate-400 border-b border-slate-800">
            <tr>
              <th class="p-3">Nombre</th>
              <th class="p-3">Especialidad</th>
              <th class="p-3">Comisión</th>
              <th class="p-3">Plan de Pauta</th>
              <th class="p-3">Estado Aliado</th>
            </tr>
          </thead>
          <tbody id="table-merchants-body" class="divide-y divide-slate-800">
            <tr><td colspan="5" class="p-4 text-center text-slate-500">Cargando comercios...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div id="tab-couriers" class="tab-content hidden bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow">
      <div class="p-4 border-b border-slate-800 font-bold">Flota de Mensajeros y Conductores</div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs">
          <thead class="bg-slate-950/50 text-slate-400 border-b border-slate-800">
            <tr>
              <th class="p-3">Nombre</th>
              <th class="p-3">Teléfono</th>
              <th class="p-3">Vehículo</th>
              <th class="p-3">Placa</th>
              <th class="p-3">Calificación</th>
              <th class="p-3">Operativo</th>
            </tr>
          </thead>
          <tbody id="table-couriers-body" class="divide-y divide-slate-800">
            <tr><td colspan="6" class="p-4 text-center text-slate-500">Cargando mensajeros...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </main>

  <script>
    function switchTab(tabId) {
      document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
      document.querySelectorAll('.tab-btn').forEach(el => {
        el.classList.remove('border-orange-500', 'text-orange-400');
        el.classList.add('border-transparent', 'text-slate-400');
      });
      document.getElementById('tab-' + tabId).classList.remove('hidden');
      const btn = document.getElementById('tab-btn-' + tabId);
      btn.classList.add('border-orange-500', 'text-orange-400');
      btn.classList.remove('border-transparent', 'text-slate-400');
    }

    async function loadAllData() {
      try {
        const stats = await fetch('/api/stats').then(r => r.json());
        document.getElementById('kpi-orders').innerText = stats.orders.total || 0;
        document.getElementById('kpi-revenue').innerText = '$' + Number(stats.ledger_volume || 0).toLocaleString('es-CO');
        document.getElementById('kpi-couriers').innerText = stats.couriers || 0;
        document.getElementById('kpi-merchants').innerText = (stats.merchants?.total || 0) + ' (' + (stats.merchants?.sponsored || 0) + ' destacados)';

        const orders = await fetch('/api/orders').then(r => r.json());
        const ordersTbody = document.getElementById('table-orders-body');
        ordersTbody.innerHTML = orders.length ? orders.map(o => \`
          <tr class="hover:bg-slate-800/50">
            <td class="p-3 font-mono font-bold text-amber-400">\${o.code}</td>
            <td class="p-3">\${o.type === 'ride' ? '🛵 Viaje' : o.type === 'package' ? '📦 Mandado' : '🍔 Comida'}</td>
            <td class="p-3">\${o.user_name || 'Cliente'}</td>
            <td class="p-3 text-slate-300">\${o.merchant_name || (o.items && o.items[0]?.item) || 'Mandado libre'}</td>
            <td class="p-3">\${o.courier_name ? o.courier_name + ' (' + o.courier_plate + ')' : '<span class="text-slate-500">Sin asignar</span>'}</td>
            <td class="p-3 font-bold">$\${Number(o.total).toLocaleString('es-CO')}</td>
            <td class="p-3">\${o.payment_method === 'cash' ? '💵 Efectivo' : '📱 Transferencia'}</td>
            <td class="p-3">
              <span class="px-2 py-0.5 rounded text-[10px] font-bold \${o.status === 'DELIVERED' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'}">\${o.status}</span>
            </td>
          </tr>
        \`).join('') : '<tr><td colspan="8" class="p-4 text-center text-slate-500">No hay órdenes registradas.</td></tr>';

        const ledger = await fetch('/api/ledger').then(r => r.json());
        const ledgerTbody = document.getElementById('table-ledger-body');
        ledgerTbody.innerHTML = ledger.length ? ledger.map(l => \`
          <tr class="hover:bg-slate-800/50 font-mono">
            <td class="p-3 text-slate-500">#\${l.id}</td>
            <td class="p-3 text-amber-400 font-bold">\${l.order_code || '-'}</td>
            <td class="p-3 text-blue-300">\${l.account}</td>
            <td class="p-3 text-emerald-400 font-bold">\${Number(l.debit) > 0 ? '+$' + Number(l.debit).toLocaleString('es-CO') : '-'}</td>
            <td class="p-3 text-orange-400 font-bold">\${Number(l.credit) > 0 ? '-$' + Number(l.credit).toLocaleString('es-CO') : '-'}</td>
            <td class="p-3 text-slate-400 font-sans">\${l.memo || '-'}</td>
          </tr>
        \`).join('') : '<tr><td colspan="6" class="p-4 text-center text-slate-500">No hay asientos contables.</td></tr>';

        const settlements = await fetch('/api/settlements').then(r => r.json());
        const settTbody = document.getElementById('table-settlements-body');
        settTbody.innerHTML = settlements.length ? settlements.map(s => \`
          <tr class="hover:bg-slate-800/50">
            <td class="p-3">\${new Date(s.date).toLocaleDateString('es-CO')}</td>
            <td class="p-3 font-semibold">\${s.courier_name} (\${s.plate || 'Moto'})</td>
            <td class="p-3">$\${Number(s.cash_collected).toLocaleString('es-CO')}</td>
            <td class="p-3 text-emerald-400">$\${Number(s.fees_earned).toLocaleString('es-CO')}</td>
            <td class="p-3 font-black text-amber-400">$\${Number(s.net).toLocaleString('es-CO')}</td>
            <td class="p-3"><span class="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-500/20 text-blue-400">\${s.status}</span></td>
          </tr>
        \`).join('') : '<tr><td colspan="6" class="p-4 text-center text-slate-500">No hay liquidaciones registradas.</td></tr>';

        const merchants = await fetch('/api/merchants').then(r => r.json());
        const merchTbody = document.getElementById('table-merchants-body');
        merchTbody.innerHTML = merchants.map(m => \`
          <tr class="hover:bg-slate-800/50">
            <td class="p-3 font-bold \${m.sponsored ? 'text-amber-400' : ''}">\${m.sponsored ? '🌟 ' : ''}\${m.name}</td>
            <td class="p-3 text-slate-400">\${m.specialty || '-'}</td>
            <td class="p-3">\${m.commission_pct}%</td>
            <td class="p-3 font-mono">\${m.ad_plan ? '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-purple-500/20 text-purple-300">' + m.ad_plan.toUpperCase() + '</span>' : 'Estándar'}</td>
            <td class="p-3">\${m.sponsored ? '<span class="text-emerald-400 font-semibold">Aliado Destacado</span>' : '<span class="text-slate-500">Orgánico</span>'}</td>
          </tr>
        \`).join('');

        const couriers = await fetch('/api/couriers').then(r => r.json());
        const courTbody = document.getElementById('table-couriers-body');
        courTbody.innerHTML = couriers.map(c => \`
          <tr class="hover:bg-slate-800/50">
            <td class="p-3 font-bold">\${c.name}</td>
            <td class="p-3 font-mono text-slate-400">\${c.wa_phone}</td>
            <td class="p-3 capitalize">\${c.vehicle}</td>
            <td class="p-3 font-mono text-amber-400">\${c.plate || '-'}</td>
            <td class="p-3 text-yellow-400"><i class="fa-solid fa-star text-xs"></i> \${c.rating || '5.0'}</td>
            <td class="p-3">\${c.is_active ? '<span class="text-emerald-400 font-bold">Activo</span>' : '<span class="text-rose-400">Inactivo</span>'}</td>
          </tr>
        \`).join('');
      } catch (e) {
        console.error("Error cargando datos:", e);
      }
    }

    loadAllData();
    setInterval(loadAllData, 10000);
  </script>
</body>
</html>`;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  return res.end(html);
});

adminServer.listen(3000, () => {
  console.log('🌐 Panel Web Administrativo (React / Dashboard) corriendo en http://localhost:3000');
});

bot.launch();
console.log('\n🚀 Fonsi (Telegram) está conectado y escuchando mensajes...');

process.once('SIGINT', () => {
  adminServer.close();
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  adminServer.close();
  bot.stop('SIGTERM');
});


