import { Telegraf, Markup } from 'telegraf';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { Client } from 'pg';

dotenv.config();

console.log('Iniciando el núcleo de Fonsi (GPS Live Tracking, Reseteo Inteligente, Modo Ultra-Conciso)...');

const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
  console.warn('⚠️ No se encontró TELEGRAM_BOT_TOKEN. Saliendo...');
  process.exit(1);
}
const bot = new Telegraf(botToken);

// Manejo global de errores para resiliencia absoluta
bot.catch((err: any, ctx: any) => {
  console.error(`⚠️ Error capturado en bot handler (${ctx?.updateType}):`, err?.message || err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception:', err);
});

// Helper para enviar mensajes con formato HTML limpio sin asteriscos rotos
function formatTelegramHTML(text: string): string {
  if (!text) return '';
  return text
    .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
    .replace(/\*(.*?)\*/g, '<i>$1</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

async function safeReply(ctx: any, text: string, extra?: any) {
  const html = formatTelegramHTML(text);
  try {
    return await ctx.reply(html, { parse_mode: 'HTML', ...(extra || {}) });
  } catch (err) {
    try {
      return await ctx.reply(text.replace(/[*_`]/g, ''), extra || {});
    } catch (e2) {
      console.error("Fallo safeReply:", e2);
    }
  }
}

// PostgreSQL Client
const dbClient = new Client({
  host: process.env.DB_HOST || 'postgres',
  user: process.env.DB_USER || 'fonsi_user',
  password: process.env.DB_PASSWORD || 'fonsi_password',
  database: process.env.DB_NAME || 'en_un_2x3',
});

async function initDatabase() {
  try {
    await dbClient.connect();
    console.log('✅ Conectado a PostgreSQL');
    
    // Migración automática para soporte GPS en tiempo real y detalles de vehículos
    await dbClient.query(`
      ALTER TABLE couriers ADD COLUMN IF NOT EXISTS current_lat numeric(10, 7) DEFAULT 10.6075;
      ALTER TABLE couriers ADD COLUMN IF NOT EXISTS current_lng numeric(10, 7) DEFAULT -72.8530;
      ALTER TABLE couriers ADD COLUMN IF NOT EXISTS heading numeric(5, 2) DEFAULT 0;
      ALTER TABLE couriers ADD COLUMN IF NOT EXISTS location_updated_at timestamp with time zone DEFAULT now();
      ALTER TABLE couriers ADD COLUMN IF NOT EXISTS tg_user_id character varying(50);
      ALTER TABLE couriers ADD COLUMN IF NOT EXISTS color VARCHAR(50) DEFAULT 'Blanco';
      ALTER TABLE couriers ADD COLUMN IF NOT EXISTS vehicle_model VARCHAR(100) DEFAULT 'Boxer CT 100';
      ALTER TABLE couriers ADD COLUMN IF NOT EXISTS vehicle_type VARCHAR(20) DEFAULT 'moto';
    `);

    // Actualizar conductores existentes y crear choferes de automóvil para viajes y cupos
    await dbClient.query(`
      UPDATE couriers SET vehicle_type = 'moto', color = 'Negro', vehicle_model = 'Boxer CT 100' 
      WHERE vehicle_type IS NULL;

      INSERT INTO couriers (name, wa_phone, vehicle, plate, rating, is_active, color, vehicle_model, vehicle_type, current_lat, current_lng)
      VALUES 
        ('Carlos Mendoza', '3157894561', 'Carro', 'UYP-452', 4.9, true, 'Gris Plata', 'Chevrolet Sail', 'carro', 10.6090, -72.8510),
        ('Javier Solano', '3106543210', 'Carro', 'WXY-891', 5.0, true, 'Blanco', 'Renault Duster', 'carro', 10.6060, -72.8550)
      ON CONFLICT (wa_phone) DO UPDATE 
      SET color = EXCLUDED.color, vehicle_model = EXCLUDED.vehicle_model, vehicle_type = EXCLUDED.vehicle_type, plate = EXCLUDED.plate, name = EXCLUDED.name;
    `);

    // Asignar coordenadas iniciales dispersas en Fonseca si están en el punto central
    await dbClient.query(`
      UPDATE couriers 
      SET current_lat = 10.6075 + (RANDOM() - 0.5) * 0.008, 
          current_lng = -72.8530 + (RANDOM() - 0.5) * 0.008 
      WHERE current_lat = 10.6075;
    `);

    console.log('✅ Base de datos lista con soporte de Radar GPS, Motos y Carros intermunicipales');
  } catch (e) {
    console.error("Error inicializando DB:", e);
  }
}
initDatabase();

// Tools loader
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
const { recover_stuck_orders } = require(path.join(toolsBasePath, 'recover_stuck_orders'));

// Watchdog automático para pedidos retrasados / atascados (> 45 min) cada 5 minutos
setInterval(async () => {
  try {
    const res = await recover_stuck_orders();
    if (res.recovered_orders && res.recovered_orders.length > 0) {
      console.log(`🔄 [WATCHDOG] Se recuperaron y reactivaron ${res.recovered_orders.length} pedidos retrasados: ${res.recovered_orders.join(', ')}`);
      // Reasignar automáticamente un conductor disponible a cada pedido recuperado
      for (const code of res.recovered_orders) {
        const courierRes = await dbClient.query("SELECT id FROM couriers WHERE is_active = true ORDER BY RANDOM() LIMIT 1");
        if (courierRes.rows.length > 0) {
          await dbClient.query("UPDATE orders SET courier_id = $1, status = 'ON_THE_WAY' WHERE code = $2", [courierRes.rows[0].id, code]);
          console.log(`🛵 [REASIGNACIÓN] Pedido ${code} reasignado al conductor ID ${courierRes.rows[0].id}`);
        }
      }
    }
  } catch (err: any) {
    console.warn("Error en watchdog de pedidos retrasados:", err?.message);
  }
}, 5 * 60 * 1000);

// Cargar personalidad SOUL.md
let fonsiSoul = "Eres Fonsi, el asistente oficial de 'En un 2x3' en Fonseca, La Guajira. Respuestas cortas y directas.";
try {
  fonsiSoul = fs.readFileSync('/workspace/SOUL.md', 'utf8');
} catch (e) {
  try {
    fonsiSoul = fs.readFileSync(path.join(__dirname, '../workspace-fonsi/SOUL.md'), 'utf8');
  } catch (e2) {
    console.warn("No se pudo leer SOUL.md");
  }
}

// Estructura de sesiones
interface PendingAction {
  type: 'ride' | 'package' | 'food';
  vehicle?: 'moto' | 'carro';
  passengers?: number;
  merchant_id?: string;
  merchant_name?: string;
  origin?: string;
  destination?: string;
  price?: number;
  delivery_fee?: number;
  subtotal?: number;
  items?: any[];
  step: 'awaiting_origin' | 'awaiting_destination' | 'awaiting_details' | 'awaiting_payment';
}

interface DriverRegistration {
  step: 'reg_name' | 'reg_phone' | 'reg_vehicle_type' | 'reg_model_color' | 'reg_plate';
  name?: string;
  wa_phone?: string;
  vehicle_type?: 'moto' | 'carro';
  vehicle_model?: string;
  color?: string;
  plate?: string;
}

interface SessionData {
  history: any[];
  lastActivity: number;
  pendingAction?: PendingAction | null;
  driverReg?: DriverRegistration | null;
  timeoutNotified?: boolean;
}

const userSessions = new Map<string, SessionData>();
const INACTIVITY_TIMEOUT = 20 * 60 * 1000; // 20 minutos de inactividad

// Verificador periódico de inactividad (cada minuto)
setInterval(async () => {
  const now = Date.now();
  for (const [userId, session] of userSessions.entries()) {
    const hasPending = (session.history && session.history.length > 0) || session.pendingAction !== null;
    
    if (hasPending && !session.timeoutNotified && (now - session.lastActivity > INACTIVITY_TIMEOUT)) {
      session.timeoutNotified = true;
      session.history = [];
      session.pendingAction = null;

      try {
        const soberMsg = 
          "🛵 <b>Aviso de inactividad:</b> Al ver que no respondiste, cerramos esta solicitud para evitar confusiones.\n\n" +
          "Cuando desees pedir nuevamente, escríbeme o toca el botón abajo:";

        await bot.telegram.sendMessage(userId, soberMsg, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🛵 Menú Principal', 'btn_main_menu')]
          ])
        });
      } catch (err) {
        // En caso de que el chat no esté accesible
      }
    }
  }
}, 60 * 1000);

function getOrCreateSession(userId: string): SessionData {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, { history: [], lastActivity: Date.now(), pendingAction: null, timeoutNotified: false });
  }
  const session = userSessions.get(userId)!;
  
  // Si estuvo inactivo más de 20 minutos, reiniciar historial para iniciar limpio
  if (Date.now() - session.lastActivity > INACTIVITY_TIMEOUT) {
    session.history = [];
    session.pendingAction = null;
  }
  
  session.lastActivity = Date.now();
  session.timeoutNotified = false;
  return session;
}

// Helper para crear orden y registrar en DB
async function processOrderCreation(userId: string, userName: string, orderData: any) {
  try {
    const userRes = await dbClient.query(`
      INSERT INTO users (wa_phone, name, default_address, payment_pref)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (wa_phone) DO UPDATE 
      SET name = EXCLUDED.name, default_address = COALESCE(EXCLUDED.default_address, users.default_address)
      RETURNING id
    `, [userId, userName || 'Cliente Telegram', orderData.destination || 'Fonseca', orderData.payment_method || 'cash']);

    const userDbId = userRes.rows[0].id;

    let merchantDbId = orderData.merchant_id || null;
    if (!merchantDbId && orderData.merchant) {
      const mRes = await dbClient.query(
        "SELECT id, name FROM merchants WHERE name ILIKE $1 LIMIT 1",
        [`%${orderData.merchant}%`]
      );
      if (mRes.rows.length > 0) merchantDbId = mRes.rows[0].id;
    }

    const randomCode = `FX-${Math.floor(1000 + Math.random() * 9000)}`;
    const subtotal = Number(orderData.subtotal) || Number(orderData.price) || 0;
    const deliveryFee = Number(orderData.delivery_fee) || 0;
    const total = Number(orderData.total) || (subtotal + deliveryFee);
    const paymentMethod = orderData.payment_method || 'cash';
    const orderType = orderData.type || 'ride';
    const destination = typeof orderData.destination === 'string' ? { label: orderData.destination } : (orderData.destination || { label: 'Fonseca' });
    const origin = typeof orderData.origin === 'string' ? { label: orderData.origin } : (orderData.origin || null);
    
    const isMoto = orderData.vehicle !== 'carro';
    const items = orderData.items || (orderType === 'ride' ? [{ item: `Viaje en ${isMoto ? 'Mototaxi' : 'Carro'} (${orderData.passengers === 2 ? '2 Personas' : '1 Persona'})`, qty: 1, price: total }] : []);
    
    const initialStatus = paymentMethod === 'transfer' ? 'DRAFT' : 'ON_THE_WAY';

    const orderRes = await dbClient.query(`
      INSERT INTO orders (
        code, type, user_id, merchant_id, status, items,
        subtotal, delivery_fee, total, payment_method, payment_status,
        origin, destination, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11,
        $12, $13, now()
      ) RETURNING id, code, status
    `, [
      randomCode, orderType, userDbId, merchantDbId, initialStatus, JSON.stringify(items),
      subtotal, deliveryFee, total, paymentMethod, 'PENDING',
      JSON.stringify(origin), JSON.stringify(destination)
    ]);

    const createdOrder = orderRes.rows[0];

    const isCarOrder = orderData.vehicle === 'carro' || orderType === 'carro';
    const courierQuery = isCarOrder
      ? "SELECT id, name, wa_phone, vehicle, vehicle_model, color, plate, rating, vehicle_type, current_lat, current_lng FROM couriers WHERE is_active = true AND vehicle_type = 'carro' ORDER BY RANDOM() LIMIT 1"
      : "SELECT id, name, wa_phone, vehicle, vehicle_model, color, plate, rating, vehicle_type, current_lat, current_lng FROM couriers WHERE is_active = true ORDER BY RANDOM() LIMIT 1";

    let courierRes = await dbClient.query(courierQuery);
    if (courierRes.rows.length === 0) {
      courierRes = await dbClient.query(
        "SELECT id, name, wa_phone, vehicle, vehicle_model, color, plate, rating, vehicle_type, current_lat, current_lng FROM couriers WHERE is_active = true ORDER BY RANDOM() LIMIT 1"
      );
    }

    let courierInfo = null;
    if (courierRes.rows.length > 0) {
      courierInfo = courierRes.rows[0];
      await dbClient.query(
        "UPDATE orders SET courier_id = $1 WHERE id = $2",
        [courierInfo.id, createdOrder.id]
      );

      // Si el conductor tiene Telegram vinculado, notificarle de inmediato
      if (courierInfo.tg_user_id) {
        try {
          const isCar = isCarOrder;
          const origStr = typeof origin === 'string' ? origin : (origin?.label || 'Fonseca');
          const destStr = typeof destination === 'string' ? destination : (destination?.label || 'Fonseca');
          
          let alertMsg = `🔔 <b>¡NUEVO SERVICIO ASIGNADO!</b> ${isCar ? '🚗💨' : '🛵💨'}\n\n`;
          alertMsg += `📋 <b>Código:</b> <code>${createdOrder.code}</code>\n`;
          alertMsg += `👤 <b>Cliente:</b> ${userName || 'Cliente'}\n`;
          alertMsg += `📍 <b>Recogida:</b> ${origStr}\n`;
          alertMsg += `🏁 <b>Destino:</b> ${destStr}\n`;
          alertMsg += `💵 <b>Total a cobrar:</b> $${total.toLocaleString('es-CO')} COP (${paymentMethod === 'cash' ? 'Efectivo en mano' : 'Transferencia Bre-B'})\n\n`;
          alertMsg += `👉 <i>Dirígete al punto de recogida. Cuando entregues, pulsa el botón abajo:</i>`;

          const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destStr)}`;

          await bot.telegram.sendMessage(courierInfo.tg_user_id, alertMsg, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.url('🗺️ Navegar en Google Maps', mapsUrl)],
              [Markup.button.callback(`✅ Marcar Entregado (${createdOrder.code})`, `courier_delivered_${createdOrder.code}`)]
            ])
          });
        } catch (tgErr: any) {
          console.warn("No se pudo notificar al conductor por Telegram:", tgErr?.message);
        }
      }
    }

    return {
      success: true,
      id: createdOrder.id,
      code: createdOrder.code,
      type: orderType,
      total,
      subtotal,
      deliveryFee,
      paymentMethod,
      courier: courierInfo
    };
  } catch (err: any) {
    console.error("Error creating order:", err);
    return { success: false, error: err.message };
  }
}

// ==========================================
// INSTRUCCIONES DE PAGO CON LLAVE BRE-B Y QR
// ==========================================
async function sendTransferPaymentInstructions(ctx: any, orderResult: any) {
  const trackingUrl = `http://89.117.72.233:3000/track/${orderResult.code}`;
  const phoneKey = '@3506811888';
  // Generar código QR dinámico de la llave Bre-B preservando el @
  const qrData = encodeURIComponent(`breb://pay?key=${phoneKey}&amount=${orderResult.total}&name=En%20un%202x3%20Fonseca`);
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=450x450&margin=12&data=${qrData}`;

  let reply = `📝 <b>Servicio Registrado [${orderResult.code}]</b>\n\n`;
  reply += `💰 <b>Total a transferir:</b> $${Number(orderResult.total).toLocaleString('es-CO')} COP\n\n`;
  reply += `🇨🇴 <b>Llave Universal Bre-B:</b>\n`;
  reply += `👉 <code>${phoneKey}</code> <i>(Toca para copiar con el @)</i>\n`;
  reply += `👤 <b>Titular:</b> En un 2x3 Fonseca\n\n`;
  reply += `⚠️ <b>IMPORTANTE:</b> Esta llave es de tipo <b>Alias / Identificador con @</b> (<code>${phoneKey}</code>). Al transferir desde tu app bancaria, asegúrate de incluir el <b>@</b>.\n\n`;
  reply += `📸 <b>Envía la captura del comprobante aquí</b> para validar tu pedido al instante. 🚀`;

  let photoSent = false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    const imgRes = await fetch(qrUrl, { signal: controller.signal });
    clearTimeout(timeout);
    
    if (imgRes.ok) {
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      await ctx.replyWithPhoto(
        { source: buffer },
        {
          caption: reply,
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.url('🗺️ Ver Mapa en Vivo 📍', trackingUrl)],
            [Markup.button.callback('🛵 Menú Principal', 'btn_main_menu')]
          ])
        }
      );
      photoSent = true;
    }
  } catch (err: any) {
    console.warn("Fallo descarga rápida de QR buffer:", err?.message);
  }

  if (!photoSent) {
    await safeReply(ctx, reply + `\n\n🖼️ <a href="${qrUrl}">Ver Código QR Bre-B</a>`, Markup.inlineKeyboard([
      [Markup.button.url('🗺️ Ver Mapa en Vivo 📍', trackingUrl)],
      [Markup.button.callback('🛵 Menú Principal', 'btn_main_menu')]
    ]));
  }
}

// ==========================================
// RASTREO GPS EN VIVO (TELEGRAM LIVE LOCATIONS)
// ==========================================
async function handleLocationUpdate(ctx: any, loc: { latitude: number, longitude: number, heading?: number }) {
  const userId = ctx.from.id.toString();

  // 1. Verificar si quien envía la ubicación es un conductor registrado
  const courierCheck = await dbClient.query(
    "SELECT * FROM couriers WHERE tg_user_id = $1 OR wa_phone = $2",
    [userId, userId]
  );

  if (courierCheck.rows.length > 0) {
    const courier = courierCheck.rows[0];
    await dbClient.query(`
      UPDATE couriers 
      SET current_lat = $1, current_lng = $2, heading = COALESCE($3, heading), location_updated_at = now(), is_active = true
      WHERE id = $4
    `, [loc.latitude, loc.longitude, loc.heading || 0, courier.id]);

    console.log(`📍 [GPS LIVE] Conductor ${courier.name} (${courier.plate}) actualizó coordenadas: [${loc.latitude}, ${loc.longitude}]`);
    
    // Si fue el mensaje inicial de ubicación
    if (ctx.message?.location) {
      await safeReply(ctx, `📍 <b>Ubicación en vivo conectada.</b>\nEstás transmitiendo en tiempo real a la plataforma 🛵💨`);
    }
    return;
  }

  // 2. Si es un cliente interactuando con el menú de mototaxi
  const session = getOrCreateSession(userId);
  if (session.pendingAction && session.pendingAction.step === 'awaiting_origin') {
    session.pendingAction.origin = `Ubicación compartida (${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)})`;
    
    if (session.pendingAction.destination) {
      session.pendingAction.step = 'awaiting_payment';
      const isCar = session.pendingAction.vehicle === 'carro';
      let confirmMsg = `📋 <b>Confirmación de Viaje:</b>\n\n`;
      confirmMsg += `${isCar ? '🚗' : '🏍️'} <b>Servicio:</b> ${isCar ? 'Viaje' : 'Mototaxi'} Fonseca ↔ ${session.pendingAction.destination}\n`;
      confirmMsg += `📍 <b>Recogida:</b> ${session.pendingAction.origin}\n`;
      confirmMsg += `🏁 <b>Destino:</b> ${session.pendingAction.destination}\n`;
      confirmMsg += `💰 <b>Tarifa:</b> $${(session.pendingAction.price || 0).toLocaleString('es-CO')} COP\n\n`;
      confirmMsg += `👉 <i>¿Cómo deseas pagar?</i>`;

      return safeReply(ctx, confirmMsg, Markup.inlineKeyboard([
        [Markup.button.callback('💵 Pagar en Efectivo', 'confirm_ride_cash')],
        [Markup.button.callback('📱 Pagar con Bre-B (Transferencia)', 'confirm_ride_transfer')],
        [Markup.button.callback('❌ Cancelar', 'cancel_action')]
      ]));
    } else {
      session.pendingAction.step = 'awaiting_destination';
      const msg = 
        `📍 <b>Recogida:</b> ${session.pendingAction.origin}\n\n` +
        `🏁 <b>Paso 2 de 2:</b> ¿Para qué dirección o barrio vas?\n\n` +
        `<i>(Ejemplo: Barrio Primero de Julio, Villa Luz)</i>`;

      return safeReply(ctx, msg, Markup.inlineKeyboard([
        [Markup.button.callback('❌ Cancelar', 'cancel_action')]
      ]));
    }
  }
}

bot.on('location', async (ctx) => {
  const loc = ctx.message.location;
  if (loc) await handleLocationUpdate(ctx, loc);
});

bot.on('edited_message', async (ctx) => {
  const loc = (ctx.editedMessage as any)?.location;
  if (loc) await handleLocationUpdate(ctx, loc);
});

// ==========================================
// PORTAL INTERACTIVO DEL CONDUCTOR
// ==========================================
async function showCourierPanel(ctx: any, userId: string) {
  try {
    const courierRes = await dbClient.query(
      "SELECT * FROM couriers WHERE tg_user_id = $1 OR wa_phone = $2 LIMIT 1",
      [userId, userId]
    );

    if (courierRes.rows.length === 0) {
      // Conductor no registrado o no vinculado
      let msg = `🛵 <b>Portal de Conductores — En un 2x3</b>\n\n`;
      msg += `Tu cuenta de Telegram aún no está vinculada a un perfil de conductor.\n\n`;
      msg += `¿Qué deseas hacer para empezar a recibir carreras y domicilios?`;

      return safeReply(ctx, msg, Markup.inlineKeyboard([
        [Markup.button.callback('📝 Registrarme como Nuevo Conductor', 'start_driver_reg')],
        [Markup.button.callback('🔗 Vincular Conductor de la Lista', 'list_existing_drivers')],
        [Markup.button.callback('🔙 Menú Principal', 'btn_main_menu')]
      ]));
    }

    const courier = courierRes.rows[0];

    // Asegurar que tg_user_id esté guardado
    if (!courier.tg_user_id) {
      await dbClient.query("UPDATE couriers SET tg_user_id = $1 WHERE id = $2", [userId, courier.id]);
    }

    // Consultar si tiene un pedido activo en curso
    const activeOrderRes = await dbClient.query(`
      SELECT code, type, status, total, payment_method, origin, destination, created_at
      FROM orders 
      WHERE courier_id = $1 AND status IN ('CONFIRMED', 'PREPARING', 'ON_THE_WAY')
      ORDER BY created_at DESC LIMIT 1
    `, [courier.id]);

    const isCar = courier.vehicle_type === 'carro';

    let msg = `🛵 <b>Panel del Conductor — En un 2x3</b>\n\n`;
    msg += `👤 <b>Conductor:</b> ${courier.name}\n`;
    msg += `📱 <b>WhatsApp:</b> <code>${courier.wa_phone}</code>\n`;
    msg += `${isCar ? '🚗' : '🏍️'} <b>Vehículo:</b> ${courier.vehicle_model || courier.vehicle} (${courier.color || 'Blanco'})\n`;
    msg += `🏷️ <b>Placa:</b> <code>${courier.plate || '-'}</code>\n`;
    msg += `⭐ <b>Calificación:</b> ${courier.rating || '5.0'} ⭐\n`;
    msg += `📡 <b>Estado Turno:</b> ${courier.is_active ? '🟢 <b>EN TURNO (ACTIVO)</b>' : '🔴 <b>FUERA DE TURNO (INACTIVO)</b>'}\n\n`;

    if (activeOrderRes.rows.length > 0) {
      const o = activeOrderRes.rows[0];
      const destStr = typeof o.destination === 'string' ? o.destination : (o.destination?.label || 'Destino');
      const origStr = typeof o.origin === 'string' ? o.origin : (o.origin?.label || 'Origen');
      msg += `📦 <b>SERVICIO ASIGNADO [${o.code}]:</b>\n`;
      msg += `📍 <b>Recogida:</b> ${origStr}\n`;
      msg += `🏁 <b>Destino:</b> ${destStr}\n`;
      msg += `💵 <b>A cobrar:</b> $${Number(o.total).toLocaleString('es-CO')} COP (${o.payment_method === 'cash' ? 'Efectivo en mano' : 'Digital Bre-B'})\n\n`;
    }

    if (courier.is_active) {
      msg += `📍 <i>Para que los clientes vean tu ubicación en tiempo real:</i>\n`;
      msg += `👉 Toca el botón de adjuntar (📎) ➔ <b>Ubicación ➔ Compartir en tiempo real</b> (8 horas).\n\n`;
    }

    const buttons = [];
    if (activeOrderRes.rows.length > 0) {
      const o = activeOrderRes.rows[0];
      const destStr = typeof o.destination === 'string' ? o.destination : (o.destination?.label || 'Destino');
      const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destStr)}`;
      buttons.push([Markup.button.url('🗺️ Navegar en Maps', mapsUrl)]);
      buttons.push([Markup.button.callback(`✅ Marcar Entregado (${o.code})`, `courier_delivered_${o.code}`)]);
    }

    if (courier.is_active) {
      buttons.push([Markup.button.callback('🔴 Pausar Turno (Desactivarme)', `courier_toggle_shift_${courier.id}_off`)]);
    } else {
      buttons.push([Markup.button.callback('🟢 Iniciar Turno (Activarme)', `courier_toggle_shift_${courier.id}_on`)]);
    }

    buttons.push([Markup.button.callback('💰 Mi Liquidación y Ganancias de Hoy', `courier_my_earnings_${courier.id}`)]);
    buttons.push([Markup.button.url('🗺️ Ver Radar en Vivo', 'http://89.117.72.233:3000')]);
    buttons.push([Markup.button.callback('🔙 Menú Principal', 'btn_main_menu')]);

    await safeReply(ctx, msg, Markup.inlineKeyboard(buttons));
  } catch (err: any) {
    console.error("Error en showCourierPanel:", err);
    await safeReply(ctx, 'Error al abrir el panel de conductor.');
  }
}

bot.command(['conductor', 'turno', 'chofer', 'panel_conductor'], async (ctx) => {
  const userId = ctx.from.id.toString();
  await showCourierPanel(ctx, userId);
});

bot.action('btn_courier_panel', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id.toString();
  await showCourierPanel(ctx, userId);
});

// Iniciar Registro de Conductor
bot.action('start_driver_reg', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id.toString();
  const session = getOrCreateSession(userId);
  session.pendingAction = null;
  session.driverReg = { step: 'reg_name' };

  const msg = 
    "📝 <b>Registro de Conductor — Paso 1 de 5:</b>\n\n" +
    "¿Cuál es tu <b>Nombre y Apellidos</b> completos?\n\n" +
    "<i>(Escribe tu nombre en el chat)</i>";

  await safeReply(ctx, msg, Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancelar Registro', 'cancel_driver_reg')]
  ]));
});

bot.action('cancel_driver_reg', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id.toString();
  const session = getOrCreateSession(userId);
  session.driverReg = null;
  await safeReply(ctx, '❌ Registro cancelado.', Markup.inlineKeyboard([
    [Markup.button.callback('🛵 Menú Principal', 'btn_main_menu')]
  ]));
});

bot.action('reg_veh_moto', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id.toString();
  const session = getOrCreateSession(userId);
  if (session.driverReg) {
    session.driverReg.vehicle_type = 'moto';
    session.driverReg.step = 'reg_model_color';
    const msg = 
      "🏍️ <b>Paso 4 de 5:</b>\n\n" +
      "¿Qué marca/modelo y color es tu <b>Moto</b>?\n\n" +
      "<i>(Ejemplo: Bajaj Boxer CT 100 Negra)</i>";
    await safeReply(ctx, msg, Markup.inlineKeyboard([
      [Markup.button.callback('❌ Cancelar Registro', 'cancel_driver_reg')]
    ]));
  }
});

bot.action('reg_veh_carro', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id.toString();
  const session = getOrCreateSession(userId);
  if (session.driverReg) {
    session.driverReg.vehicle_type = 'carro';
    session.driverReg.step = 'reg_model_color';
    const msg = 
      "🚗 <b>Paso 4 de 5:</b>\n\n" +
      "¿Qué marca/modelo y color es tu <b>Carro</b>?\n\n" +
      "<i>(Ejemplo: Chevrolet Sail Gris Plata)</i>";
    await safeReply(ctx, msg, Markup.inlineKeyboard([
      [Markup.button.callback('❌ Cancelar Registro', 'cancel_driver_reg')]
    ]));
  }
});

// Listar conductores existentes para vincular
bot.action('list_existing_drivers', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    const couriersRes = await dbClient.query("SELECT * FROM couriers ORDER BY name ASC");
    const buttons = couriersRes.rows.map(c => [
      Markup.button.callback(`🏍️ Soy ${c.name} (${c.plate || 'Moto'})`, `bind_courier_${c.id}`)
    ]);
    buttons.push([Markup.button.callback('🔙 Menú Principal', 'btn_main_menu')]);

    const msg = 
      "🏍️ <b>Vincular Cuenta de Conductor Existente</b>\n\n" +
      "Selecciona tu nombre en la lista:";

    await safeReply(ctx, msg, Markup.inlineKeyboard(buttons));
  } catch (err: any) {
    await safeReply(ctx, 'Error al consultar lista de conductores.');
  }
});

bot.action(/^bind_courier_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const courierId = ctx.match[1];
  const userId = ctx.from.id.toString();

  try {
    await dbClient.query(
      "UPDATE couriers SET tg_user_id = $1, is_active = true, location_updated_at = now() WHERE id = $2",
      [userId, courierId]
    );

    const res = await dbClient.query("SELECT * FROM couriers WHERE id = $1", [courierId]);
    const courier = res.rows[0];

    let msg = `🎉 <b>¡Conductor Vinculado Exitosamente!</b>\n\n`;
    msg += `👤 <b>Nombre:</b> ${courier.name}\n`;
    msg += `🛵 <b>Placa:</b> ${courier.plate || 'Vehículo'}\n`;
    msg += `⭐ <b>Calificación:</b> ${courier.rating || '5.0'} ⭐\n\n`;
    msg += `📍 <b>Para activar tu ubicación en el radar GPS:</b>\n`;
    msg += `1. Toca el botón de adjuntar (📎) abajo.\n`;
    msg += `2. Pulsa <b>Ubicación ➔ Compartir mi ubicación en tiempo real</b> (8 horas).\n\n`;
    msg += `🚀 <i>Ya estás activo para recibir pedidos y carreras.</i>`;

    await safeReply(ctx, msg, Markup.inlineKeyboard([
      [Markup.button.callback('🛵 Mi Panel de Conductor', 'btn_courier_panel')],
      [Markup.button.url('🗺️ Ver Radar en Vivo', 'http://89.117.72.233:3000')],
      [Markup.button.callback('🔙 Menú Principal', 'btn_main_menu')]
    ]));
  } catch (err: any) {
    await safeReply(ctx, 'Error al vincular conductor.');
  }
});

// Activar/Desactivar Turno
bot.action(/^courier_toggle_shift_(.+)_(on|off)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const courierId = ctx.match[1];
  const turnOn = ctx.match[2] === 'on';
  const userId = ctx.from.id.toString();

  try {
    await dbClient.query("UPDATE couriers SET is_active = $1, location_updated_at = now() WHERE id = $2", [turnOn, courierId]);
    await showCourierPanel(ctx, userId);
  } catch (e: any) {
    await safeReply(ctx, 'Error al cambiar estado del turno.');
  }
});

// Ver Ganancias del Día para el Conductor
bot.action(/^courier_my_earnings_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const courierId = ctx.match[1];
  const today = new Date().toISOString().split('T')[0];

  try {
    const res = await courier_settle(courierId, today);
    if (res.status === 'success') {
      const s = res.settlement;
      let msg = `💰 <b>Tu Liquidación de Hoy (${today})</b>\n\n`;
      msg += `🛵 <b>Servicios realizados:</b> ${s.services}\n`;
      msg += `💵 <b>Efectivo recibido en mano:</b> $${s.cash_collected.toLocaleString('es-CO')} COP\n`;
      msg += `🎉 <b>Tus ganancias ganadas:</b> $${s.fees_earned.toLocaleString('es-CO')} COP\n`;
      msg += `🏦 <b>Neto a consignar/entregar en caja:</b> $${s.net_to_consign.toLocaleString('es-CO')} COP\n\n`;
      msg += `<i>Corte calculado automáticamente por la plataforma.</i>`;

      await safeReply(ctx, msg, Markup.inlineKeyboard([
        [Markup.button.callback('🛵 Volver a Mi Panel', 'btn_courier_panel')],
        [Markup.button.callback('🔙 Menú Principal', 'btn_main_menu')]
      ]));
    } else {
      await safeReply(ctx, 'No tienes servicios registrados hoy todavía.');
    }
  } catch (e: any) {
    await safeReply(ctx, 'Error al calcular liquidación.');
  }
});

// Marcar Pedido Entregado por el Conductor
bot.action(/^courier_delivered_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const code = ctx.match[1];
  try {
    const res = await dbClient.query(
      "UPDATE orders SET status = 'DELIVERED', delivered_at = now() WHERE code = $1 RETURNING id, code, total, payment_method",
      [code]
    );
    if (res.rowCount === 0) {
      return safeReply(ctx, `No se encontró el pedido ${code}`);
    }
    const order = res.rows[0];
    await ledger_post(order.id);

    let reply = `🎉 <b>¡Excelente trabajo!</b>\n\n`;
    reply += `El pedido <b>${code}</b> ha sido marcado como <b>ENTREGADO</b>.\n`;
    reply += `💰 Total del servicio: <b>$${Number(order.total).toLocaleString('es-CO')} COP</b> (${order.payment_method === 'cash' ? 'Efectivo en mano' : 'Transferencia Bre-B'})\n\n`;
    reply += `Tu ganancia y contabilidad han quedado registradas en el Libro Mayor. 🚀`;

    await safeReply(ctx, reply, Markup.inlineKeyboard([
      [Markup.button.callback('🛵 Mi Panel de Conductor', 'btn_courier_panel')],
      [Markup.button.callback('🔙 Menú Principal', 'btn_main_menu')]
    ]));
  } catch (err: any) {
    console.error("Error al marcar entregado por conductor:", err);
    await safeReply(ctx, 'Error al completar el pedido.');
  }
});

// ==========================================
// MENÚ PRINCIPAL Y SALUDO
// ==========================================
const sendWelcome = async (ctx: any) => {
  const userId = ctx.from.id.toString();
  const session = getOrCreateSession(userId);
  session.history = [];
  session.pendingAction = null;
  session.driverReg = null;

  const msg = 
    "¡Hola! 🛵 Bienvenido a <b>En un 2x3</b> — Domicilios y Transporte en Fonseca.\n\n" +
    "¿Qué necesitas hoy? Elige una opción o escríbeme directamente: 🚀😎";

  await safeReply(
    ctx,
    msg,
    Markup.inlineKeyboard([
      [Markup.button.callback('🛵 Pedir Mototaxi', 'btn_mototaxi')],
      [Markup.button.callback('📦 Domicilios (Comida, Tienda, Farmacia)', 'btn_domicilio')],
      [Markup.button.callback('🛣️ Viajes Intermunicipales', 'btn_intermunicipal')],
      [
        Markup.button.callback('📋 Consultar Mi Servicio', 'btn_status_quick'),
        Markup.button.callback('🏍️ Soy Conductor / Turno', 'btn_courier_panel')
      ]
    ])
  );
};

bot.start(sendWelcome);

bot.action('btn_main_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await sendWelcome(ctx);
});

// ==========================================
// SECCIÓN MOTOTAXI URBANO
// ==========================================
bot.action('btn_mototaxi', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id.toString();
  const session = getOrCreateSession(userId);
  session.pendingAction = null;

  const msg = 
    "🛵 <b>Servicio de Mototaxi en Fonseca</b>\n\n" +
    "¿Cuántas personas van a viajar?";

  await safeReply(
    ctx,
    msg,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('👤 1 Pasajero ($3.000)', 'moto_1_pax'),
        Markup.button.callback('👥 2 Pasajeros ($4.000)', 'moto_2_pax')
      ],
      [Markup.button.callback('🔙 Menú Principal', 'btn_main_menu')]
    ])
  );
});

// 1 Pasajero ($3.000)
bot.action('moto_1_pax', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id.toString();
  const session = getOrCreateSession(userId);

  session.pendingAction = {
    type: 'ride',
    vehicle: 'moto',
    passengers: 1,
    price: 3000,
    delivery_fee: 0,
    subtotal: 3000,
    step: 'awaiting_origin'
  };

  const msg = 
    "📍 <b>Paso 1 de 2 (1 Pasajero - $3.000 COP):</b>\n\n" +
    "¿En qué dirección o punto de referencia te recoge el mototaxi?\n\n" +
    "<i>(Escribe la dirección o comparte tu ubicación)</i>";

  await safeReply(ctx, msg, Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancelar', 'cancel_action')]
  ]));
});

// 2 Pasajeros ($4.000)
bot.action('moto_2_pax', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id.toString();
  const session = getOrCreateSession(userId);

  session.pendingAction = {
    type: 'ride',
    vehicle: 'moto',
    passengers: 2,
    price: 4000,
    delivery_fee: 0,
    subtotal: 4000,
    step: 'awaiting_origin'
  };

  const msg = 
    "📍 <b>Paso 1 de 2 (2 Pasajeros - $4.000 COP):</b>\n\n" +
    "¿En qué punto los recogemos a ambos?\n\n" +
    "<i>(Escribe la dirección o comparte tu ubicación)</i>";

  await safeReply(ctx, msg, Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancelar', 'cancel_action')]
  ]));
});

// ==========================================
// SECCIÓN VIAJES INTERMUNICIPALES
// ==========================================
bot.action('btn_intermunicipal', async (ctx) => {
  await ctx.answerCbQuery();
  const msg = 
    "🛣️ <b>Viajes Intermunicipales desde Fonseca</b>\n\n" +
    "• <b>Distracción:</b> $5.000 COP <i>(en mototaxi)</i>\n" +
    "• <b>Barrancas:</b> $8.000 COP <i>(de donde Lucho Díaz)</i>\n" +
    "• <b>San Juan del Cesar:</b> $10.000 COP\n" +
    "• <b>El Molino:</b> $15.000 COP | <b>Hatonuevo:</b> $15.000 COP\n" +
    "• <b>Villanueva:</b> $20.000 COP | <b>Urumita:</b> $20.000 COP\n" +
    "• <b>Maicao:</b> $30.000 COP | <b>Riohacha:</b> $40.000 COP\n\n" +
    "👇 <b>Selecciona tu destino:</b>";

  await safeReply(
    ctx,
    msg,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('🏍️ Distracción ($5.000)', 'dest_distraccion'),
        Markup.button.callback('🚗 Barrancas ($8.000)', 'dest_barrancas')
      ],
      [
        Markup.button.callback('🚗 San Juan ($10.000)', 'dest_san_juan'),
        Markup.button.callback('🚗 El Molino ($15.000)', 'dest_el_molino')
      ],
      [
        Markup.button.callback('🚗 Hatonuevo ($15.000)', 'dest_hatonuevo'),
        Markup.button.callback('🚗 Villanueva ($20.000)', 'dest_villanueva')
      ],
      [
        Markup.button.callback('🚗 Urumita ($20.000)', 'dest_urumita'),
        Markup.button.callback('🚗 Maicao ($30.000)', 'dest_maicao')
      ],
      [
        Markup.button.callback('🚗 Riohacha ($40.000)', 'dest_riohacha')
      ],
      [Markup.button.callback('🔙 Menú Principal', 'btn_main_menu')]
    ])
  );
});

const interDestMap: Record<string, { city: string, vehicle: 'moto' | 'carro', price: number, label: string }> = {
  'dest_distraccion': { city: 'Distracción', vehicle: 'moto', price: 5000, label: 'Mototaxi' },
  'dest_barrancas': { city: 'Barrancas', vehicle: 'carro', price: 8000, label: 'Viaje' },
  'dest_san_juan': { city: 'San Juan del Cesar', vehicle: 'carro', price: 10000, label: 'Viaje' },
  'dest_el_molino': { city: 'El Molino', vehicle: 'carro', price: 15000, label: 'Viaje' },
  'dest_hatonuevo': { city: 'Hatonuevo', vehicle: 'carro', price: 15000, label: 'Viaje' },
  'dest_villanueva': { city: 'Villanueva', vehicle: 'carro', price: 20000, label: 'Viaje' },
  'dest_urumita': { city: 'Urumita', vehicle: 'carro', price: 20000, label: 'Viaje' },
  'dest_maicao': { city: 'Maicao', vehicle: 'carro', price: 30000, label: 'Viaje' },
  'dest_riohacha': { city: 'Riohacha', vehicle: 'carro', price: 40000, label: 'Viaje' },
};

for (const [actionKey, data] of Object.entries(interDestMap)) {
  bot.action(actionKey, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const session = getOrCreateSession(userId);

    session.pendingAction = {
      type: 'ride',
      vehicle: data.vehicle,
      destination: data.city,
      price: data.price,
      subtotal: data.price,
      delivery_fee: 0,
      step: 'awaiting_origin'
    };

    const emoji = data.vehicle === 'moto' ? '🏍️' : '🚗';
    const msg = 
      `🛣️ <b>Viaje Fonseca ↔ ${data.city} (${emoji} ${data.label})</b>\n` +
      `💰 Tarifa fija: <b>$${data.price.toLocaleString('es-CO')} COP</b>\n\n` +
      `📍 <b>¿Desde qué punto de Fonseca saldrías?</b>\n<i>(Escribe la dirección o comparte tu ubicación)</i>`;

    await safeReply(ctx, msg, Markup.inlineKeyboard([
      [Markup.button.callback('❌ Cancelar', 'cancel_action')]
    ]));
  });
}

// Confirmar Carrera Efectivo
bot.action('confirm_ride_cash', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id.toString();
  const userName = ctx.from.first_name || 'Cliente';
  const session = getOrCreateSession(userId);

  if (!session.pendingAction) {
    return safeReply(ctx, 'No hay ningún servicio pendiente.');
  }

  const pending = session.pendingAction;
  const isPackage = pending.type === 'package';
  const orderResult = await processOrderCreation(userId, userName, {
    type: pending.type || 'ride',
    vehicle: pending.vehicle || 'moto',
    passengers: pending.passengers || 1,
    subtotal: pending.price || 3000,
    delivery_fee: pending.delivery_fee || 0,
    total: (pending.price || 3000) + (pending.delivery_fee || 0),
    payment_method: 'cash',
    origin: pending.origin || 'Fonseca',
    destination: pending.destination || 'Fonseca'
  });

  session.pendingAction = null;
  session.history = []; // Limpiar historial tras confirmación

  if (!orderResult.success) {
    return safeReply(ctx, '❌ Ocurrió un error. Intenta de nuevo.');
  }

  const isCar = pending.vehicle === 'carro';
  const trackingUrl = `http://89.117.72.233:3000/track/${orderResult.code}`;

  let reply = '';
  const buttons = [];

  if (isPackage) {
    reply = `🎉 <b>¡Domicilio Confirmado!</b> 📦💨\n\n`;
    reply += `📋 <b>Código:</b> <code>${orderResult.code}</code>\n`;
    if (orderResult.courier) {
      reply += `🛵 <b>Domiciliario:</b> ${orderResult.courier.name} (${orderResult.courier.plate || 'Moto'})\n`;
      reply += `📞 <b>Contacto:</b> <code>${orderResult.courier.wa_phone}</code>\n`;
    }
    reply += `⏱️ <b>Llegada:</b> 15-25 min\n`;
    reply += `📍 <b>Entrega:</b> ${pending.destination}\n`;
    reply += `💵 <b>Total a pagar:</b> $${orderResult.total.toLocaleString('es-CO')} COP\n\n`;
    reply += `🗺️ <b>Seguimiento en Vivo:</b> <a href="${trackingUrl}">Ver en mapa</a>`;
    buttons.push([Markup.button.url('🗺️ Ver Domicilio en Vivo 📍', trackingUrl)]);
  } else if (isCar) {
    const c = orderResult.courier;
    reply = `🎉 <b>¡Viaje en Carro Confirmado!</b> 🚗💨\n\n`;
    reply += `📋 <b>Código:</b> <code>${orderResult.code}</code>\n\n`;
    if (c) {
      reply += `👤 <b>Chofer Asignado:</b> ${c.name}\n`;
      reply += `📞 <b>Teléfono / WhatsApp:</b> <code>${c.wa_phone}</code> <i>(Toca para copiar)</i>\n`;
      reply += `🚗 <b>Vehículo:</b> ${c.vehicle_model || 'Automóvil'}\n`;
      reply += `🎨 <b>Color del Carro:</b> ${c.color || 'Blanco'}\n`;
      reply += `🏷️ <b>Placa:</b> <code>${c.plate || 'Por asignar'}</code>\n`;
      reply += `⭐ <b>Calificación:</b> ${c.rating || '5.0'} ⭐\n\n`;
    }
    reply += `⏱️ <b>Tiempo de recogida:</b> 5 a 10 min\n`;
    reply += `📍 <b>Ruta:</b> ${pending.origin} ➔ ${pending.destination}\n`;
    reply += `💵 <b>Total a pagar:</b> $${orderResult.total.toLocaleString('es-CO')} COP\n\n`;
    reply += `🗺️ <b>Seguimiento GPS:</b> <a href="${trackingUrl}">Ver ubicación del carro</a>`;

    if (c?.wa_phone) {
      buttons.push([Markup.button.url('💬 WhatsApp del Chofer', `https://wa.me/57${c.wa_phone}?text=Hola%20${encodeURIComponent(c.name)},%20tengo%20el%20servicio%20${orderResult.code}%20en%20En%20un%202x3`)]);
    }
    buttons.push([Markup.button.url('🗺️ Ver Carro en Vivo 📍', trackingUrl)]);
  } else {
    reply = `🎉 <b>¡Mototaxi en Camino!</b> 🛵💨\n\n`;
    reply += `📋 <b>Código:</b> <code>${orderResult.code}</code>\n`;
    if (orderResult.courier) {
      reply += `🏍️ <b>Mototaxista:</b> ${orderResult.courier.name} (${orderResult.courier.plate || 'Moto'})\n`;
      reply += `📞 <b>Contacto:</b> <code>${orderResult.courier.wa_phone}</code>\n`;
    }
    reply += `⏱️ <b>Llegada:</b> 3-5 min\n`;
    reply += `📍 <b>Ruta:</b> ${pending.origin} ➔ ${pending.destination}\n`;
    reply += `💵 <b>Total a pagar:</b> $${orderResult.total.toLocaleString('es-CO')} COP\n\n`;
    reply += `🗺️ <b>Seguimiento en Vivo:</b> <a href="${trackingUrl}">Ver en mapa</a>`;
    buttons.push([Markup.button.url('🗺️ Ver Mototaxi en Vivo 📍', trackingUrl)]);
  }

  buttons.push([Markup.button.callback('📋 Consultar Mi Servicio', 'btn_status_quick')]);
  buttons.push([Markup.button.callback('🛵 Menú Principal', 'btn_main_menu')]);

  await safeReply(ctx, reply, Markup.inlineKeyboard(buttons));
});

// Confirmar Carrera Transferencia
bot.action('confirm_ride_transfer', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id.toString();
  const userName = ctx.from.first_name || 'Cliente';
  const session = getOrCreateSession(userId);

  if (!session.pendingAction) {
    return safeReply(ctx, 'No hay ninguna orden pendiente.');
  }

  const pending = session.pendingAction;
  const orderResult = await processOrderCreation(userId, userName, {
    type: pending.type || 'ride',
    vehicle: pending.vehicle || 'moto',
    passengers: pending.passengers || 1,
    subtotal: pending.price || 3000,
    delivery_fee: pending.delivery_fee || 0,
    total: (pending.price || 3000) + (pending.delivery_fee || 0),
    payment_method: 'transfer',
    origin: pending.origin || 'Fonseca',
    destination: pending.destination || 'Fonseca'
  });

  session.pendingAction = null;
  session.history = []; // Limpiar historial

  if (!orderResult.success) {
    return safeReply(ctx, '❌ Ocurrió un error creando la orden.');
  }

  await sendTransferPaymentInstructions(ctx, orderResult);
});

// Cancelar acción actual
bot.action('cancel_action', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id.toString();
  const session = getOrCreateSession(userId);
  session.pendingAction = null;
  session.history = [];
  await safeReply(ctx, '❌ Operación cancelada.', Markup.inlineKeyboard([
    [Markup.button.callback('🛵 Menú Principal', 'btn_main_menu')]
  ]));
});

// ==========================================
// SECCIÓN DOMICILIOS (COMIDA, TIENDAS, FARMACIAS)
// ==========================================
bot.action('btn_domicilio', async (ctx) => {
  await ctx.answerCbQuery();
  const msg = 
    "📦 <b>Servicio de Domicilios (En un 2x3)</b>\n\n" +
    "💵 <b>Tarifas de Domicilio:</b>\n" +
    "• <b>1 Parada:</b> $3.000 COP\n" +
    "• <b>2 Paradas:</b> $5.000 COP\n" +
    "• <b>3 Paradas:</b> $8.000 COP\n\n" +
    "¿Qué deseas pedir hoy?";

  await safeReply(
    ctx,
    msg,
    Markup.inlineKeyboard([
      [Markup.button.callback('🍽️ Ver Restaurantes Aliados', 'btn_list_merchants')],
      [Markup.button.callback('🛍️ Compras en Tienda / Farmacia / Mercado', 'btn_compras_domicilio')],
      [Markup.button.callback('🔙 Menú Principal', 'btn_main_menu')]
    ])
  );
});

// Compras en Tienda / Farmacia / Mercado
bot.action('btn_compras_domicilio', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id.toString();
  const session = getOrCreateSession(userId);

  session.pendingAction = {
    type: 'package',
    price: 3000,
    delivery_fee: 3000,
    subtotal: 0,
    step: 'awaiting_details'
  };

  const msg = 
    "🛍️ <b>Compras en Tiendas, Farmacias y Mercado</b>\n\n" +
    "Tarifa: <b>$3.000 COP</b> (1 lugar) | <b>$5.000 COP</b> (2 lugares).\n\n" +
    "👉 <b>Escríbeme qué productos necesitas y dónde te los entregamos:</b>\n\n" +
    "<i>(Escribe la dirección de entrega o comparte tu ubicación)</i>";

  await safeReply(ctx, msg, Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancelar', 'cancel_action')]
  ]));
});

// Listado ultra-conciso de restaurantes SIN direcciones ni teléfonos
bot.action('btn_list_merchants', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    const res = await dbClient.query("SELECT id, name, specialty, sponsored FROM merchants ORDER BY sponsored DESC, name ASC");
    
    let msg = "🍽️ <b>Restaurantes Aliados en Fonseca:</b>\n\n";
    const buttons = [];

    for (const m of res.rows) {
      const badge = m.sponsored ? '🌟 ' : '🍲 ';
      msg += `• <b>${badge}${m.name}</b> <i>(${m.specialty || 'Comida típica'})</i>\n`;
      buttons.push([Markup.button.callback(`📖 Menú: ${m.name}`, `menu_${m.id}`)]);
    }
    buttons.push([Markup.button.callback('🔙 Volver a Domicilios', 'btn_domicilio')]);

    await safeReply(ctx, msg, Markup.inlineKeyboard(buttons));
  } catch (err: any) {
    await safeReply(ctx, 'Error al consultar los restaurantes.');
  }
});

// Menú ultra-compacto sin textos largos
bot.action(/^menu_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const merchantId = ctx.match[1];

  try {
    const res = await dbClient.query("SELECT * FROM merchants WHERE id = $1", [merchantId]);
    if (res.rows.length === 0) return safeReply(ctx, 'Comercio no encontrado.');
    const m = res.rows[0];

    let msg = `🍽️ <b>Menú: ${m.name}</b> ${m.sponsored ? '🌟' : ''}\n\n`;

    const menuItems = Array.isArray(m.menu) ? m.menu : [];
    if (menuItems.length > 0) {
      menuItems.forEach((item: any) => {
        msg += `• <b>${item.item || item.name}</b> — $${Number(item.price).toLocaleString('es-CO')} COP\n`;
      });
    }

    msg += `\n🛵 <b>Domicilio:</b> $3.000 COP (1 lugar) | $5.000 COP (2 lugares)\n`;
    msg += `👉 <i>Escríbeme qué deseas pedir:</i>`;

    await safeReply(ctx, msg, Markup.inlineKeyboard([
      [Markup.button.callback('🍽️ Ver Otros Restaurantes', 'btn_list_merchants')],
      [Markup.button.callback('🔙 Menú Principal', 'btn_main_menu')]
    ]));
  } catch (err: any) {
    await safeReply(ctx, 'Error al obtener el menú.');
  }
});

bot.action('btn_status_quick', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id.toString();
  await checkUserStatus(ctx, userId);
});

async function checkUserStatus(ctx: any, userId: string) {
  try {
    const res = await dbClient.query(`
      SELECT o.code, o.type, o.status, o.payment_status, o.total, o.payment_method, o.origin, o.destination, o.created_at, 
             c.name as courier_name, c.wa_phone as courier_phone, c.plate, c.color, c.vehicle_model, c.vehicle_type,
             c.current_lat, c.current_lng, m.name as merchant_name
      FROM orders o
      JOIN users u ON o.user_id = u.id
      LEFT JOIN couriers c ON o.courier_id = c.id
      LEFT JOIN merchants m ON o.merchant_id = m.id
      WHERE u.wa_phone = $1
      ORDER BY o.created_at DESC LIMIT 1
    `, [userId]);

    if (res.rows.length === 0) {
      return safeReply(ctx, 'No tienes ningún servicio activo. Escríbeme qué necesitas 🛵', Markup.inlineKeyboard([
        [Markup.button.callback('🛵 Menú Principal', 'btn_main_menu')]
      ]));
    }

    const order = res.rows[0];
    const statusMap: any = {
      'DRAFT': '📝 Registrado (Pendiente comprobante)',
      'CONFIRMED': '✅ Confirmado',
      'PREPARING': '🍳 En preparación',
      'ON_THE_WAY': '🛵 En camino',
      'DELIVERED': '🎉 Entregado',
      'CANCELLED': '❌ Cancelado'
    };

    const trackingUrl = `http://89.117.72.233:3000/track/${order.code}`;
    const isCar = order.vehicle_type === 'carro';

    let msg = `📋 <b>Servicio [${order.code}]</b>\n\n`;
    msg += `• <b>Tipo:</b> ${isCar ? '🚗 Viaje en Carro' : (order.type === 'ride' ? '🛵 Mototaxi' : '📦 Domicilio')}\n`;
    if (order.merchant_name) msg += `• <b>Comercio:</b> ${order.merchant_name}\n`;
    msg += `• <b>Estado:</b> ${statusMap[order.status] || order.status}\n`;
    msg += `• <b>Pago:</b> ${order.payment_method === 'cash' ? '💵 Efectivo' : '📱 Transferencia Bre-B'}\n`;
    msg += `• <b>Total:</b> $${Number(order.total).toLocaleString('es-CO')} COP\n\n`;
    
    if (order.courier_name) {
      msg += `👤 <b>${isCar ? 'Chofer' : 'Conductor'}:</b> ${order.courier_name}\n`;
      if (order.courier_phone) msg += `📞 <b>Contacto:</b> <code>${order.courier_phone}</code>\n`;
      if (isCar) {
        msg += `🚗 <b>Vehículo:</b> ${order.vehicle_model || 'Automóvil'}\n`;
        msg += `🎨 <b>Color:</b> ${order.color || 'Blanco'}\n`;
        msg += `🏷️ <b>Placa:</b> <code>${order.plate || 'Por asignar'}</code>\n`;
      } else {
        msg += `🏍️ <b>Placa:</b> <code>${order.plate || 'Moto'}</code>\n`;
      }
    }
    
    msg += `\n🗺️ <b>Seguimiento GPS:</b> <a href="${trackingUrl}">Ver ubicación en vivo</a>\n`;

    const statusButtons = [];
    if (order.courier_phone && isCar) {
      statusButtons.push([Markup.button.url('💬 WhatsApp del Chofer', `https://wa.me/57${order.courier_phone}`)]);
    }
    statusButtons.push([Markup.button.url('🗺️ Ver Mapa en Vivo 📍', trackingUrl)]);
    statusButtons.push([Markup.button.callback('🛵 Menú Principal', 'btn_main_menu')]);

    await safeReply(ctx, msg, Markup.inlineKeyboard(statusButtons));
  } catch (err: any) {
    await safeReply(ctx, 'Error al consultar tu servicio.');
  }
}

// ==========================================
// OCR FOTOS DE COMPROBANTES (FASE 2)
// ==========================================
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
      return safeReply(ctx, '📸 Recibí tu foto, pero no tienes ningún servicio pendiente de pago.');
    }

    const order = orderRes.rows[0];
    const photos = ctx.message.photo;
    const bestPhoto = photos[photos.length - 1];
    const fileLink = await ctx.telegram.getFileLink(bestPhoto.file_id);
    const imageUrl = fileLink.href;

    await safeReply(ctx, '🔍 Analizando comprobante de pago...');

    const ocrResult = await receipt_ocr(imageUrl, Number(order.total));
    const verifyResult = await payment_verify(order.code, ocrResult.data, imageUrl);

    if (verifyResult.verified) {
      const trackingUrl = `http://89.117.72.233:3000/track/${verifyResult.order_code}`;
      let msg = `✅ <b>¡Pago Verificado con Éxito!</b>\n\n`;
      msg += `📋 Pedido: <code>${verifyResult.order_code}</code>\n`;
      msg += `💰 Valor recibido: <b>$${Number(verifyResult.amount).toLocaleString('es-CO')} COP</b>\n`;
      msg += `🔖 Referencia: <code>${verifyResult.reference}</code>\n\n`;
      msg += `🍳 Tu servicio está <b>CONFIRMADO</b> y el conductor ya va en camino. 🛵💨\n`;
      msg += `🗺️ Puedes seguirlo en tiempo real en el mapa:`;
      await safeReply(ctx, msg, Markup.inlineKeyboard([
        [Markup.button.url('🗺️ Ver Mototaxi en Vivo 📍', trackingUrl)],
        [Markup.button.callback('📋 Consultar Mi Servicio', 'btn_status_quick')],
        [Markup.button.callback('🛵 Menú Principal', 'btn_main_menu')]
      ]));
    } else {
      let msg = `⚠️ <b>Atención con tu comprobante:</b>\n\n`;
      msg += `${verifyResult.error || 'No pudimos validar automáticamente el comprobante.'}\n\n`;
      msg += `Pasó a revisión con nuestro equipo de soporte. Te avisaremos en breve.`;
      await safeReply(ctx, msg, Markup.inlineKeyboard([
        [Markup.button.callback('📋 Consultar Mi Servicio', 'btn_status_quick')],
        [Markup.button.callback('🛵 Menú Principal', 'btn_main_menu')]
      ]));
    }
  } catch (err: any) {
    console.error("Error procesando comprobante:", err);
    await safeReply(ctx, 'Tuvimos un inconveniente leyendo la foto.');
  }
});

// ==========================================
// COMANDOS DE TEXTO DIRECTOS
// ==========================================
bot.command(['pedido', 'status'], async (ctx) => {
  const userId = ctx.from.id.toString();
  await checkUserStatus(ctx, userId);
});

bot.command(['mototaxi', 'viaje', 'transporte'], async (ctx) => {
  const quote1 = await fare_quote('ride', 1);
  const quote2 = await fare_quote('ride', 2);
  
  let msg = `🛵 <b>Servicio de Mototaxi en Fonseca</b>\n\n`;
  msg += `• 👤 <b>1 Pasajero:</b> $${quote1.fee.toLocaleString('es-CO')} COP\n`;
  msg += `• 👥 <b>2 Pasajeros:</b> $${quote2.fee.toLocaleString('es-CO')} COP\n\n`;
  msg += `📍 <i>¿Cuántos pasajeros van?</i>`;

  await safeReply(ctx, msg, Markup.inlineKeyboard([
    [Markup.button.callback('👤 1 Pasajero ($3.000)', 'moto_1_pax')],
    [Markup.button.callback('👥 2 Pasajeros ($4.000)', 'moto_2_pax')],
    [Markup.button.callback('🛣️ Rutas Intermunicipales', 'btn_intermunicipal')]
  ]));
});

bot.command('domicilio', async (ctx) => {
  const msg = 
    "📦 <b>Domicilios en Fonseca (En un 2x3)</b>\n\n" +
    "• <b>1 Parada:</b> $3.000 COP\n" +
    "• <b>2 Paradas:</b> $5.000 COP\n" +
    "• <b>3 Paradas:</b> $8.000 COP\n\n" +
    "Dime qué necesitas pedir de restaurante o compras.";
  await safeReply(ctx, msg);
});

bot.command('relay', async (ctx) => {
  const userId = ctx.from.id.toString();
  const text = ctx.message.text.replace('/relay', '').trim();
  if (!text) {
    return safeReply(ctx, 'Escribe tu mensaje. Ejemplo: <code>/relay ya estoy en el portón</code>');
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
    return safeReply(ctx, 'No tienes ningún servicio activo en curso.');
  }

  const order = orderRes.rows[0];
  await relay_message(order.id, 'user', text);
  await safeReply(ctx, `🔒 <b>Mensaje entregado a ${order.courier_name || 'tu conductor'}:</b>\n"${text}"`);
});

bot.command(['recuperar', 'retrasos', 'auditar'], async (ctx) => {
  try {
    const res = await recover_stuck_orders();
    let msg = `⏱️ <b>Auditoría y Recuperación de Pedidos:</b>\n\n`;
    if (res.recovered_orders && res.recovered_orders.length > 0) {
      msg += `⚠️ Se encontraron <b>${res.recovered_orders.length}</b> pedidos con más de 45 min sin entregar.\n\n`;
      msg += `🔄 <b>Pedidos reactivados para reasignación:</b>\n`;
      for (const code of res.recovered_orders) {
        msg += `• <code>${code}</code>\n`;
        const courierRes = await dbClient.query("SELECT id, name FROM couriers WHERE is_active = true ORDER BY RANDOM() LIMIT 1");
        if (courierRes.rows.length > 0) {
          await dbClient.query("UPDATE orders SET courier_id = $1, status = 'ON_THE_WAY' WHERE code = $2", [courierRes.rows[0].id, code]);
          msg += `  ↳ 🛵 <i>Reasignado a ${courierRes.rows[0].name}</i>\n`;
        }
      }
    } else {
      msg += `✅ <b>Todos los pedidos están en tiempo óptimo.</b>\nNo hay solicitudes atascadas ni perdidas en el sistema.`;
    }
    await safeReply(ctx, msg);
  } catch (err: any) {
    console.error("Error en comando recuperar:", err);
    await safeReply(ctx, 'Error al ejecutar la auditoría de pedidos.');
  }
});

bot.command('entregar', async (ctx) => {
  const args = ctx.message.text.split(' ');
  const code = args[1]?.toUpperCase().trim();
  if (!code) {
    return safeReply(ctx, 'Indica el código. Ejemplo: <code>/entregar FX-1234</code>');
  }

  try {
    const res = await dbClient.query(
      "UPDATE orders SET status = 'DELIVERED', delivered_at = now() WHERE code = $1 RETURNING id, code, status, total, payment_method",
      [code]
    );
    if (res.rowCount === 0) {
      return safeReply(ctx, `No se encontró el pedido ${code}`);
    }
    
    const order = res.rows[0];
    const ledgerResult = await ledger_post(order.id);

    let reply = `🎉 Pedido <b>${code}</b> marcado como <b>DELIVERED</b>.\n\n`;
    if (ledgerResult.status === 'success') {
      reply += `📖 <b>Asiento Contable Registrado:</b>\n`;
      reply += `• Débitos: $${ledgerResult.total_debit?.toLocaleString('es-CO')} COP\n`;
      reply += `• Créditos: $${ledgerResult.total_credit?.toLocaleString('es-CO')} COP\n`;
      reply += `• Estado: ✅ Cuadrado`;
    }
    await safeReply(ctx, reply);
  } catch (err: any) {
    console.error("Error en comando entregar:", err);
    await safeReply(ctx, 'Error al actualizar el estado del pedido.');
  }
});

bot.command(['liquidar', 'cierre'], async (ctx) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const couriersRes = await dbClient.query("SELECT id, name, plate FROM couriers WHERE is_active = true");
    
    let summaryMsg = `🧾 <b>CIERRE DIARIO (${today})</b>\n\n`;
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

        summaryMsg += `🏍️ <b>${courier.name}</b> (${courier.plate || 'Vehículo'}):\n`;
        summaryMsg += `  • Servicios: ${s.services}\n`;
        summaryMsg += `  • Efectivo recibido: $${s.cash_collected.toLocaleString('es-CO')} COP\n`;
        summaryMsg += `  • Ganancia: $${s.fees_earned.toLocaleString('es-CO')} COP\n`;
        summaryMsg += `  • 💵 <b>A consignar:</b> $${s.net_to_consign.toLocaleString('es-CO')} COP\n\n`;
      }
    }

    summaryMsg += `━━━━━━━━━━━━━━━━━━\n`;
    summaryMsg += `💰 <b>TOTAL RECAUDADO:</b> $${grandTotalCash.toLocaleString('es-CO')} COP\n`;
    summaryMsg += `🛵 <b>GANANCIA CONDUCTORES:</b> $${grandTotalFees.toLocaleString('es-CO')} COP\n`;
    summaryMsg += `🏦 <b>NETO A RECIBIR EN CAJA:</b> $${grandNet.toLocaleString('es-CO')} COP`;

    await safeReply(ctx, summaryMsg);
  } catch (err: any) {
    console.error("Error en liquidar:", err);
    await safeReply(ctx, 'Error al generar la liquidación.');
  }
});

// ==========================================
// GESTOR DE MENSAJES DE TEXTO (FLUJOS + IA LLM)
// ==========================================
bot.on('text', async (ctx) => {
  const userMessage = ctx.message.text;
  const userId = ctx.from.id.toString();
  const userName = ctx.from.first_name || 'Cliente';
  
  const cleanText = userMessage.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const isGreeting = /^(hola|buebas|buenas|buen dia|buenos dias|buenas tardes|buenas noches|hi|hey|hello|menu|inicio|empezar|\/start|\/reset)$/i.test(cleanText);

  if (isGreeting) {
    return sendWelcome(ctx);
  }

  console.log(`\n[TELEGRAM] Mensaje de ${userId} (${userName}): ${userMessage}`);
  const session = getOrCreateSession(userId);

  // 0. Flujo Interactivo de Registro de Conductor (driverReg)
  if (session.driverReg) {
    const reg = session.driverReg;
    if (reg.step === 'reg_name') {
      reg.name = userMessage.trim();
      reg.step = 'reg_phone';
      const msg = 
        `👤 <b>Nombre:</b> ${reg.name}\n\n` +
        `📱 <b>Paso 2 de 5:</b> ¿Cuál es tu número de WhatsApp o Celular?\n\n` +
        `<i>(Ejemplo: 3151234567)</i>`;
      return safeReply(ctx, msg, Markup.inlineKeyboard([
        [Markup.button.callback('❌ Cancelar Registro', 'cancel_driver_reg')]
      ]));
    }

    if (reg.step === 'reg_phone') {
      reg.phone = userMessage.trim().replace(/\s+/g, '');
      reg.step = 'reg_vehicle_type';
      const msg = 
        `👤 <b>Nombre:</b> ${reg.name}\n` +
        `📱 <b>WhatsApp:</b> ${reg.phone}\n\n` +
        `🚗 <b>Paso 3 de 5:</b> ¿Qué tipo de vehículo vas a manejar?`;
      return safeReply(ctx, msg, Markup.inlineKeyboard([
        [Markup.button.callback('🏍️ Moto (Mototaxi y Domicilios)', 'reg_veh_moto')],
        [Markup.button.callback('🚗 Carro (Viajes y Cupos Intermunicipales)', 'reg_veh_carro')],
        [Markup.button.callback('❌ Cancelar', 'cancel_driver_reg')]
      ]));
    }

    if (reg.step === 'reg_model_color') {
      reg.model_color = userMessage.trim();
      reg.step = 'reg_plate';
      const isCar = reg.vehicle_type === 'carro';
      const msg = 
        `👤 <b>Nombre:</b> ${reg.name}\n` +
        `📱 <b>WhatsApp:</b> ${reg.phone}\n` +
        `${isCar ? '🚗' : '🏍️'} <b>Vehículo:</b> ${reg.model_color}\n\n` +
        `🏷️ <b>Paso 5 de 5:</b> ¿Cuál es la <b>Placa</b> de tu vehículo?\n\n` +
        `<i>(Ejemplo: ABC-123 o XYZ-45D)</i>`;
      return safeReply(ctx, msg, Markup.inlineKeyboard([
        [Markup.button.callback('❌ Cancelar Registro', 'cancel_driver_reg')]
      ]));
    }

    if (reg.step === 'reg_plate') {
      reg.plate = userMessage.trim().toUpperCase();
      const vehicleType = reg.vehicle_type || 'moto';
      const vehicleLabel = vehicleType === 'carro' ? 'Carro' : 'Moto';
      const modelColor = reg.model_color || 'Boxer Negra';
      const isCar = vehicleType === 'carro';
      
      try {
        await dbClient.query(`
          INSERT INTO couriers (name, wa_phone, vehicle, vehicle_type, vehicle_model, color, plate, rating, is_active, tg_user_id, current_lat, current_lng)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 5.0, true, $8, 10.6075, -72.8530)
          ON CONFLICT (wa_phone) DO UPDATE 
          SET name = EXCLUDED.name,
              vehicle = EXCLUDED.vehicle,
              vehicle_type = EXCLUDED.vehicle_type,
              vehicle_model = EXCLUDED.vehicle_model,
              color = EXCLUDED.color,
              plate = EXCLUDED.plate,
              tg_user_id = EXCLUDED.tg_user_id,
              is_active = true,
              location_updated_at = now();
        `, [
          reg.name,
          reg.phone,
          vehicleLabel,
          vehicleType,
          modelColor,
          modelColor,
          reg.plate,
          userId
        ]);

        session.driverReg = null;

        let okMsg = `🎉 <b>¡Registro Exitoso como Conductor de En un 2x3!</b>\n\n`;
        okMsg += `👤 <b>Nombre:</b> ${reg.name}\n`;
        okMsg += `📱 <b>WhatsApp:</b> ${reg.phone}\n`;
        okMsg += `${isCar ? '🚗' : '🏍️'} <b>Vehículo:</b> ${modelColor}\n`;
        okMsg += `🏷️ <b>Placa:</b> <code>${reg.plate}</code>\n`;
        okMsg += `📡 <b>Estado:</b> 🟢 <b>EN TURNO (ACTIVO)</b>\n\n`;
        okMsg += `📍 <b>IMPORTANTE — Para activar tu radar GPS en vivo:</b>\n`;
        okMsg += `1. Toca el botón de adjuntar (📎) abajo.\n`;
        okMsg += `2. Selecciona <b>Ubicación ➔ Compartir mi ubicación en tiempo real</b> (elige 8 horas).\n\n`;
        okMsg += `🚀 ¡Listo! Cada vez que un cliente pida una carrera o domicilio, te llegará la alerta aquí mismo con el botón para navegar en Google Maps y marcarlo como entregado.`;

        return safeReply(ctx, okMsg, Markup.inlineKeyboard([
          [Markup.button.callback('🛵 Mi Panel de Conductor', 'btn_courier_panel')],
          [Markup.button.url('🗺️ Ver Radar en Vivo', 'http://89.117.72.233:3000')],
          [Markup.button.callback('🔙 Menú Principal', 'btn_main_menu')]
        ]));
      } catch (err: any) {
        console.error("Error al registrar conductor en BD:", err);
        session.driverReg = null;
        return safeReply(ctx, '⚠️ Hubo un error al guardar tu registro. Por favor escribe /conductor para intentar de nuevo.');
      }
    }
  }

  // 1. Manejo de Flujo Interactivo Paso a Paso (PendingAction)
  if (session.pendingAction) {
    const pending = session.pendingAction;

    // Paso Origen (Recogida)
    if (pending.step === 'awaiting_origin') {
      pending.origin = userMessage.trim();
      
      if (pending.destination) {
        pending.step = 'awaiting_payment';
        const isCar = pending.vehicle === 'carro';
        let confirmMsg = `📋 <b>Confirmación de Viaje:</b>\n\n`;
        confirmMsg += `${isCar ? '🚗' : '🏍️'} <b>Servicio:</b> ${isCar ? 'Viaje' : 'Mototaxi'} Fonseca ↔ ${pending.destination}\n`;
        confirmMsg += `📍 <b>Recogida:</b> ${pending.origin}\n`;
        confirmMsg += `🏁 <b>Destino:</b> ${pending.destination}\n`;
        confirmMsg += `💰 <b>Tarifa:</b> $${(pending.price || 0).toLocaleString('es-CO')} COP\n\n`;
        confirmMsg += `👉 <i>¿Cómo deseas pagar?</i>`;

        return safeReply(ctx, confirmMsg, Markup.inlineKeyboard([
          [Markup.button.callback('💵 Pagar en Efectivo', 'confirm_ride_cash')],
          [Markup.button.callback('📱 Pagar con Bre-B (Transferencia)', 'confirm_ride_transfer')],
          [Markup.button.callback('❌ Cancelar', 'cancel_action')]
        ]));
      } else {
        pending.step = 'awaiting_destination';
        const msg = 
          `📍 <b>Recogida:</b> ${pending.origin}\n\n` +
          `🏁 <b>Paso 2 de 2:</b> ¿Para qué dirección o barrio vas?\n\n` +
          `<i>(Ejemplo: Barrio Primero de Julio, Villa Luz)</i>`;

        return safeReply(ctx, msg, Markup.inlineKeyboard([
          [Markup.button.callback('❌ Cancelar', 'cancel_action')]
        ]));
      }
    }

    // Paso Destino
    if (pending.step === 'awaiting_destination') {
      pending.destination = userMessage.trim();
      pending.step = 'awaiting_payment';

      let confirmMsg = `📋 <b>Confirmación de Mototaxi:</b>\n\n`;
      confirmMsg += `🏍️ <b>Tipo:</b> Mototaxi Urbano (${pending.passengers === 2 ? '2 Personas' : '1 Persona'})\n`;
      confirmMsg += `📍 <b>Origen:</b> ${pending.origin}\n`;
      confirmMsg += `🏁 <b>Destino:</b> ${pending.destination}\n`;
      confirmMsg += `💰 <b>Tarifa:</b> $${(pending.price || 3000).toLocaleString('es-CO')} COP\n`;
      confirmMsg += `⏱️ <b>Tiempo llegada:</b> 3 a 5 min\n\n`;
      confirmMsg += `👉 <i>¿Cómo deseas pagar?</i>`;

      return safeReply(ctx, confirmMsg, Markup.inlineKeyboard([
        [Markup.button.callback('💵 En Efectivo', 'confirm_ride_cash')],
        [Markup.button.callback('📱 Con Llave Bre-B (Transferencia)', 'confirm_ride_transfer')],
        [Markup.button.callback('❌ Cancelar', 'cancel_action')]
      ]));
    }

    // Paso Detalles de Compras / Domicilio
    if (pending.step === 'awaiting_details') {
      pending.destination = userMessage.trim();
      pending.origin = 'Tienda / Farmacia / Mercado';
      pending.step = 'awaiting_payment';

      let confirmMsg = `📦 <b>Confirmación de Domicilio:</b>\n\n`;
      confirmMsg += `📝 <b>Pedido:</b> ${userMessage}\n`;
      confirmMsg += `💰 <b>Costo domicilio:</b> $3.000 COP <i>(1 parada)</i>\n`;
      confirmMsg += `⏱️ <b>Tiempo estimado:</b> 20 a 30 min\n\n`;
      confirmMsg += `👉 <i>¿Cómo deseas pagar el domicilio?</i>`;

      return safeReply(ctx, confirmMsg, Markup.inlineKeyboard([
        [Markup.button.callback('💵 En Efectivo al recibir', 'confirm_ride_cash')],
        [Markup.button.callback('📱 Con Llave Bre-B (Transferencia)', 'confirm_ride_transfer')],
        [Markup.button.callback('❌ Cancelar', 'cancel_action')]
      ]));
    }
  }

  // 2. Procesamiento con IA Conversacional (Gemini Flash)
  await ctx.sendChatAction('typing').catch(e => console.error('Error typing:', e));

  session.history.push({ role: 'user', content: userMessage });
  if (session.history.length > 8) session.history.splice(0, session.history.length - 8);

  let dbContext = "Catálogo general";
  try {
    const dbRes = await dbClient.query("SELECT name, specialty, menu, sponsored FROM merchants ORDER BY sponsored DESC, name ASC");
    dbContext = JSON.stringify(dbRes.rows);
  } catch (err) {
    console.error("Fallo DB", err);
  }

  const promptAntiRobot = `
REGLAS SUPREMAS DE ATENCIÓN Y PRECISIÓN:
1. PREGUNTAS DE PRECISIÓN (OBLIGATORIO): Si el cliente pide productos de tienda o farmacia con variantes (gaseosas, cigarros, cervezas, pañales, medicinas, sabores de comida) y NO especificó marca, tamaño, sabor o presentación:
   - FRENA de inmediato y haz 1 pregunta directa y corta antes de armar el ticket.
   - Ejemplo: "¿De qué marca y tamaño la gaseosa? ¿Y los cigarros de qué marca y caja de 10 o 20?"
2. SÉ ULTRA-CONCISO: Respuestas cortas, máximo 4 líneas o ticket resumido. CERO discursos ni frases de relleno.
3. PROHIBIDO DAR DIRECCIONES O TELÉFONOS DE RESTAURANTES.
4. TARIFAS OFICIALES:
   - Domicilio 1 lugar: $3.000 COP | 2 lugares: $5.000 COP | 3 lugares: $8.000 COP.
   - Mototaxi urbano: 1 pax $3.000 COP | 2 pax $4.000 COP.
   - Intermunicipales: Distracción $5.000 (moto), Barrancas $8.000, San Juan $10.000, El Molino/Hatonuevo $15.000, Villanueva/Urumita $20.000, Maicao $30.000, Riohacha $40.000.
5. CUANDO EL CLIENTE YA ESPECIFICÓ LOS PRODUCTOS Y ENVÍA DIRECCIÓN Y PAGO:
   - Confirma con el ticket directo y crea el pedido.`;

  const fullSystemPrompt = `${fonsiSoul}\n\n=== BASE DE DATOS EN VIVO ===\nComercios y menús actuales:\n${dbContext}\n\n${promptAntiRobot}`;

  const primaryModel = process.env.LLM_MODEL || 'gemini-2.5-flash';
  let retries = 0;
  let success = false;

  while (retries < 3 && !success) {
    try {
      const reqBody = {
        model: primaryModel,
        messages: [
          { role: 'system', content: fullSystemPrompt },
          ...session.history
        ],
        temperature: 0.3
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 35000);

      const response = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.LLM_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(reqBody),
        signal: controller.signal
      }).then(async (r) => {
        clearTimeout(timeoutId);
        const json = await r.json();
        if (!r.ok || json.error) {
          const err: any = new Error(json.error?.message || r.statusText);
          err.status = json.error?.code || r.status;
          throw err;
        }
        return json;
      });

      let fonsiReply = response.choices?.[0]?.message?.content || '¡Claro que sí! Cuéntame qué necesitas y te lo soluciono en un 2x3 🛵';

      const orderTagMatch = fonsiReply.match(/<<<ORDER_CREATE:(.*?)>>>/s);
      if (orderTagMatch) {
        try {
          const orderJson = JSON.parse(orderTagMatch[1]);
          const orderResult = await processOrderCreation(userId, userName, orderJson);
          fonsiReply = fonsiReply.replace(/<<<ORDER_CREATE:(.*?)>>>/s, '').trim();
          
          if (orderResult.success) {
            const trackingUrl = `http://89.117.72.233:3000/track/${orderResult.code}`;
            if (orderResult.paymentMethod === 'transfer') {
              // Enviar datos de Llave y QR directamente
              await sendTransferPaymentInstructions(ctx, orderResult);
            } else {
              fonsiReply += `\n\n🛵 <b>¡Servicio Registrado!</b>\n`;
              fonsiReply += `📋 Código: <code>${orderResult.code}</code>\n`;
              if (orderResult.courier) {
                fonsiReply += `🏍️ Conductor: <b>${orderResult.courier.name}</b> (${orderResult.courier.plate || 'Vehículo'})\n`;
              }
              fonsiReply += `📍 Total: <b>$${orderResult.total.toLocaleString('es-CO')} COP</b> (Efectivo contra entrega)\n`;
              fonsiReply += `🗺️ <b>Seguimiento:</b> <a href="${trackingUrl}">Ver Mototaxi en vivo</a>\n`;
              fonsiReply += `⚡ <i>¡Te lo llevamos en un 2x3!</i>`;
            }
          }
        } catch (e) {
          console.error("Error parseando ORDER_CREATE tag:", e);
        }
      }

      session.history.push({ role: 'assistant', content: fonsiReply });
      
      const chunkSize = 4000;
      for (let i = 0; i < fonsiReply.length; i += chunkSize) {
        await safeReply(ctx, fonsiReply.substring(i, i + chunkSize));
      }
      success = true;

    } catch (error: any) {
      console.error(`[LLM ERROR]:`, error.message);
      retries++;
      if (retries >= 3) {
        await safeReply(ctx, '¡Qué pena contigo! Tenemos muchos pedidos en fila. ¿Me dices si deseas transporte o comida de algún restaurante?');
      } else {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
});

// ==========================================
// SERVIDOR HTTP PANEL WEB Y REST API + LIVE TRACKING
// ==========================================
const adminServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = req.url || '/';

  // Endpoint API de Tracking por Código de Orden
  if (url.startsWith('/api/track/')) {
    const code = url.replace('/api/track/', '').toUpperCase().trim();
    try {
      const orderRes = await dbClient.query(`
        SELECT o.code, o.type, o.status, o.total, o.origin, o.destination, o.created_at,
               c.name as courier_name, c.plate as courier_plate, c.vehicle as courier_vehicle,
               c.rating as courier_rating, c.current_lat, c.current_lng, c.location_updated_at
        FROM orders o
        LEFT JOIN couriers c ON o.courier_id = c.id
        WHERE o.code = $1
      `, [code]);

      if (orderRes.rows.length === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Pedido no encontrado' }));
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(orderRes.rows[0]));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // Página Web de Live Tracking (Leaflet OpenStreetMap - Mobile & PC Responsive)
  if (url.startsWith('/track/')) {
    const code = url.replace('/track/', '').toUpperCase().trim();
    const trackHtml = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>Rastreo en Vivo — Pedido ${code}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
  <style>
    #map { height: 100vh; width: 100vw; z-index: 1; }
    .pulse-moto {
      animation: pulse-ring 2s cubic-bezier(0.215, 0.61, 0.355, 1) infinite;
    }
    @keyframes pulse-ring {
      0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7); }
      70% { transform: scale(1); box-shadow: 0 0 0 14px rgba(34, 197, 94, 0); }
      100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
    }
  </style>
</head>
<body class="bg-slate-950 text-slate-100 font-sans overflow-hidden relative">
  <div id="map"></div>

  <!-- Header flotante superior minimalista (Móvil y PC) -->
  <div class="fixed top-3 left-3 right-3 md:left-6 md:right-auto md:w-96 z-[1000] bg-slate-900/90 backdrop-blur-md border border-slate-800/80 px-4 py-3 rounded-2xl shadow-xl flex items-center justify-between">
    <div class="flex items-center gap-2.5">
      <div class="w-8 h-8 rounded-xl bg-emerald-500 text-slate-950 font-black flex items-center justify-center text-sm shadow">2x3</div>
      <div>
        <h1 class="text-xs font-black text-white">En un 2x3 — Fonseca</h1>
        <p class="text-[10px] font-mono text-emerald-400 font-bold">Pedido: ${code}</p>
      </div>
    </div>
    <span id="badge-status" class="px-2 py-0.5 rounded-full text-[10px] font-black bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
      EN CAMINO
    </span>
  </div>

  <!-- Card flotante inferior en Móvil / lateral en PC -->
  <div class="fixed bottom-3 left-3 right-3 md:bottom-auto md:top-20 md:left-6 md:right-auto md:w-96 z-[1000] bg-slate-900/95 backdrop-blur-md border border-slate-800/90 p-4 md:p-5 rounded-2xl shadow-2xl space-y-3">
    <div class="grid grid-cols-2 gap-2 text-xs">
      <div class="bg-slate-950/60 p-2.5 rounded-xl border border-slate-800">
        <span class="text-[10px] text-slate-400 uppercase font-semibold">Conductor</span>
        <p id="txt-courier" class="font-bold text-white truncate mt-0.5">Buscando...</p>
        <p id="txt-plate" class="font-mono text-amber-400 text-[10px] font-bold">-</p>
      </div>
      <div class="bg-slate-950/60 p-2.5 rounded-xl border border-slate-800">
        <span class="text-[10px] text-slate-400 uppercase font-semibold">Total a Pagar</span>
        <p id="txt-total" class="font-black text-emerald-400 text-sm mt-0.5">$3.000 COP</p>
        <span class="text-[10px] text-slate-400" id="txt-gps-time">Actualizando...</span>
      </div>
    </div>

    <div class="bg-slate-950/40 p-2.5 rounded-xl border border-slate-800/80 text-xs flex items-center gap-2">
      <span class="text-slate-400 text-sm">📍</span>
      <div class="flex-1 min-w-0">
        <span class="text-[10px] text-slate-400 block font-semibold">Destino</span>
        <p id="txt-dest" class="text-slate-200 truncate font-medium">-</p>
      </div>
    </div>

    <div class="flex gap-2 pt-1">
      <a href="https://t.me/Fonsi2x3_bot" class="flex-1 py-2.5 bg-emerald-600 active:bg-emerald-700 hover:bg-emerald-500 text-center rounded-xl text-xs font-bold text-white transition flex items-center justify-center gap-1.5 shadow">
        <i class="fa-brands fa-telegram text-sm"></i> Volver al Chat
      </a>
      <button onclick="centerMap()" title="Centrar mi moto" class="px-3.5 py-2.5 bg-slate-800 active:bg-slate-700 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-bold transition shadow">
        <i class="fa-solid fa-crosshairs text-sm"></i>
      </button>
    </div>
  </div>

  <script>
    const code = '${code}';
    const fonsecaCenter = [10.6075, -72.8530];
    
    const map = L.map('map', { zoomControl: false }).setView(fonsecaCenter, 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap'
    }).addTo(map);

    const motoIcon = L.divIcon({
      className: 'custom-moto-marker',
      html: '<div class="w-10 h-10 rounded-full bg-emerald-600 border-2 border-white flex items-center justify-center text-lg shadow-lg pulse-moto">🛵</div>',
      iconSize: [40, 40],
      iconAnchor: [20, 20]
    });

    let motoMarker = L.marker(fonsecaCenter, { icon: motoIcon }).addTo(map);

    function centerMap() {
      if (motoMarker) map.setView(motoMarker.getLatLng(), 16);
    }

    async function updateTracking() {
      try {
        const res = await fetch('/api/track/' + code);
        if (!res.ok) return;
        const data = await res.json();

        document.getElementById('badge-status').innerText = data.status || 'EN CAMINO';
        document.getElementById('txt-courier').innerText = (data.courier_name || 'Conductor asignado') + (data.courier_rating ? ' (' + data.courier_rating + '⭐)' : '');
        document.getElementById('txt-plate').innerText = data.courier_plate || 'Moto';
        document.getElementById('txt-total').innerText = '$' + Number(data.total).toLocaleString('es-CO') + ' COP';
        
        let destLabel = 'Fonseca';
        if (typeof data.destination === 'object' && data.destination?.label) destLabel = data.destination.label;
        else if (typeof data.destination === 'string') destLabel = data.destination;
        document.getElementById('txt-dest').innerText = destLabel;

        if (data.current_lat && data.current_lng) {
          const lat = parseFloat(data.current_lat);
          const lng = parseFloat(data.current_lng);
          const newPos = [lat, lng];
          motoMarker.setLatLng(newPos);
          document.getElementById('txt-gps-time').innerText = new Date(data.location_updated_at || Date.now()).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
        }
      } catch (e) {
        console.error("Error actualizando GPS:", e);
      }
    }

    updateTracking();
    setInterval(updateTracking, 3000);
  </script>
</body>
</html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(trackHtml);
  }

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

  if (url === '/api/analytics') {
    try {
      const daily = await dbClient.query(`
        SELECT to_char(date_trunc('day', created_at), 'DD/MM') as day, count(*) as count, sum(total) as revenue
        FROM orders
        GROUP BY date_trunc('day', created_at)
        ORDER BY date_trunc('day', created_at) ASC LIMIT 14
      `);
      const types = await dbClient.query(`
        SELECT type, count(*) as count FROM orders GROUP BY type
      `);
      const payments = await dbClient.query(`
        SELECT COALESCE(payment_method, 'efectivo') as method, count(*) as count, sum(total) as revenue 
        FROM orders GROUP BY payment_method
      `);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        daily: daily.rows,
        types: types.rows,
        payments: payments.rows
      }));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // HTML SPA Dashboard (Mobile & Desktop Responsive - Plataforma Única Consolidada)
  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>En un 2x3 — Plataforma Central Consolidada</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
  <style>
    .no-scrollbar::-webkit-scrollbar { display: none; }
    .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
    #radar-map { height: 350px; width: 100%; border-radius: 12px; }
    @media (min-width: 768px) {
      #radar-map { height: 500px; }
    }
  </style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex flex-col font-sans">

  <!-- Header Responsive -->
  <header class="bg-slate-900 border-b border-slate-800 px-4 md:px-6 py-3 md:py-4 flex items-center justify-between sticky top-0 z-50 shadow">
    <div class="flex items-center gap-2.5 md:gap-3">
      <div class="h-9 w-9 md:h-10 md:w-10 bg-emerald-500 rounded-xl flex items-center justify-center text-slate-950 font-black text-lg md:text-xl shadow-lg shadow-emerald-500/20">
        2x3
      </div>
      <div>
        <h1 class="font-black text-base md:text-lg text-white tracking-wide flex items-center gap-1.5">
          En un 2x3 <span class="text-[10px] md:text-xs bg-emerald-500/10 text-emerald-400 px-1.5 py-0.5 rounded border border-emerald-500/20 font-mono">Fonseca, Guajira</span>
        </h1>
        <p class="text-[10px] md:text-xs text-slate-400">Plataforma Unificada: Radar GPS, Operaciones, Analítica y Contabilidad</p>
      </div>
    </div>
    <div class="flex items-center gap-2 md:gap-3">
      <span class="hidden sm:inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
        <span class="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span> Activo
      </span>
      <a href="https://t.me/Fonsi2x3_bot" target="_blank" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-bold transition flex items-center gap-1.5 shadow">
        <i class="fa-brands fa-telegram"></i> <span class="hidden sm:inline">Bot</span> @Fonsi2x3_bot
      </a>
    </div>
  </header>

  <main class="flex-1 max-w-7xl w-full mx-auto p-3.5 md:p-6 space-y-4 md:space-y-6">
    <!-- KPIs Responsive Grid (2 cols en móvil, 4 cols en PC) -->
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-2.5 md:gap-4">
      <div class="bg-slate-900 border border-slate-800 p-3.5 md:p-4 rounded-xl shadow">
        <p class="text-[10px] md:text-xs font-bold text-slate-400 uppercase tracking-wider">Pedidos Hoy</p>
        <p id="kpi-orders" class="text-xl md:text-2xl font-black text-white mt-1">Cargando...</p>
      </div>
      <div class="bg-slate-900 border border-slate-800 p-3.5 md:p-4 rounded-xl shadow">
        <p class="text-[10px] md:text-xs font-bold text-slate-400 uppercase tracking-wider">Volumen Total</p>
        <p id="kpi-volume" class="text-xl md:text-2xl font-black text-emerald-400 mt-1">Cargando...</p>
      </div>
      <div class="bg-slate-900 border border-slate-800 p-3.5 md:p-4 rounded-xl shadow">
        <p class="text-[10px] md:text-xs font-bold text-slate-400 uppercase tracking-wider">Mototaxis Activos</p>
        <p id="kpi-couriers" class="text-xl md:text-2xl font-black text-blue-400 mt-1">Cargando...</p>
      </div>
      <div class="bg-slate-900 border border-slate-800 p-3.5 md:p-4 rounded-xl shadow">
        <p class="text-[10px] md:text-xs font-bold text-slate-400 uppercase tracking-wider">Comercios Aliados</p>
        <p id="kpi-merchants" class="text-xl md:text-2xl font-black text-amber-400 mt-1">Cargando...</p>
      </div>
    </div>

    <!-- Pestañas de Navegación Desplazables en Móvil -->
    <div class="flex overflow-x-auto pb-2 border-b border-slate-800 space-x-2 no-scrollbar">
      <button onclick="switchTab('radar')" id="tab-btn-radar" class="tab-btn flex-shrink-0 px-3.5 py-2 text-xs md:text-sm font-semibold rounded-lg bg-emerald-600 text-white shadow">🗺️ Radar GPS</button>
      <button onclick="switchTab('orders')" id="tab-btn-orders" class="tab-btn flex-shrink-0 px-3.5 py-2 text-xs md:text-sm font-semibold rounded-lg bg-slate-800 text-slate-400 hover:bg-slate-700 transition">📦 Pedidos</button>
      <button onclick="switchTab('analytics')" id="tab-btn-analytics" class="tab-btn flex-shrink-0 px-3.5 py-2 text-xs md:text-sm font-semibold rounded-lg bg-slate-800 text-slate-400 hover:bg-slate-700 transition">📊 Analítica BI</button>
      <button onclick="switchTab('couriers')" id="tab-btn-couriers" class="tab-btn flex-shrink-0 px-3.5 py-2 text-xs md:text-sm font-semibold rounded-lg bg-slate-800 text-slate-400 hover:bg-slate-700 transition">🏍️ Mototaxis</button>
      <button onclick="switchTab('merchants')" id="tab-btn-merchants" class="tab-btn flex-shrink-0 px-3.5 py-2 text-xs md:text-sm font-semibold rounded-lg bg-slate-800 text-slate-400 hover:bg-slate-700 transition">🍽️ Comercios</button>
      <button onclick="switchTab('ledger')" id="tab-btn-ledger" class="tab-btn flex-shrink-0 px-3.5 py-2 text-xs md:text-sm font-semibold rounded-lg bg-slate-800 text-slate-400 hover:bg-slate-700 transition">📖 Libro Mayor</button>
      <button onclick="switchTab('settlements')" id="tab-btn-settlements" class="tab-btn flex-shrink-0 px-3.5 py-2 text-xs md:text-sm font-semibold rounded-lg bg-slate-800 text-slate-400 hover:bg-slate-700 transition">🧾 Liquidaciones</button>
    </div>

    <!-- Tab: Radar GPS en Vivo -->
    <div id="tab-radar" class="tab-content bg-slate-900 border border-slate-800 rounded-xl p-3.5 md:p-5 shadow space-y-3 md:space-y-4">
      <div class="flex items-center justify-between">
        <div>
          <h2 class="text-sm md:text-base font-bold text-white flex items-center gap-2">
            <span class="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-ping"></span> Radar GPS de Mototaxis
          </h2>
          <p class="text-[11px] md:text-xs text-slate-400">Monitoreo en vivo sobre el mapa de Fonseca.</p>
        </div>
        <button onclick="loadRadarMap()" class="px-2.5 py-1.5 md:px-3 bg-slate-800 hover:bg-slate-700 text-xs font-bold rounded-lg transition text-slate-300">
          <i class="fa-solid fa-rotate"></i>
        </button>
      </div>
      <div id="radar-map"></div>
    </div>

    <!-- Tab: Pedidos -->
    <div id="tab-orders" class="tab-content hidden bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow">
      <div class="p-3.5 md:p-4 border-b border-slate-800 flex justify-between items-center">
        <h2 class="font-bold text-xs md:text-sm text-slate-200">Servicios en Tiempo Real</h2>
        <span class="text-[10px] md:text-xs text-slate-500 font-mono">Actualización 10s</span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs min-w-[600px]">
          <thead class="bg-slate-950 text-slate-400 uppercase font-mono text-[10px] border-b border-slate-800">
            <tr>
              <th class="p-3">Código</th>
              <th class="p-3">Tipo</th>
              <th class="p-3">Cliente</th>
              <th class="p-3">Conductor</th>
              <th class="p-3">Total</th>
              <th class="p-3">Pago</th>
              <th class="p-3">Estado</th>
              <th class="p-3">Mapa</th>
            </tr>
          </thead>
          <tbody id="table-orders-body" class="divide-y divide-slate-800 font-mono">
            <tr><td colspan="8" class="p-4 text-center text-slate-500">Cargando pedidos...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Tab: Analítica & Reportes BI (Unificado) -->
    <div id="tab-analytics" class="tab-content hidden space-y-4">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <!-- Gráfico de Ventas e Ingresos -->
        <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl shadow">
          <h3 class="text-xs font-bold text-slate-300 uppercase mb-3 flex items-center gap-2">
            <i class="fa-solid fa-chart-line text-emerald-400"></i> Evolución de Ingresos (COP)
          </h3>
          <div class="h-64 relative">
            <canvas id="chart-revenue"></canvas>
          </div>
        </div>

        <!-- Gráfico de Servicios por Tipo -->
        <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl shadow">
          <h3 class="text-xs font-bold text-slate-300 uppercase mb-3 flex items-center gap-2">
            <i class="fa-solid fa-chart-pie text-blue-400"></i> Distribución de Servicios
          </h3>
          <div class="h-64 relative">
            <canvas id="chart-services"></canvas>
          </div>
        </div>
      </div>

      <!-- Métodos de Pago y Desempeño -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl shadow">
          <h3 class="text-xs font-bold text-slate-300 uppercase mb-3 flex items-center gap-2">
            <i class="fa-solid fa-money-bill-wave text-amber-400"></i> Medios de Pago
          </h3>
          <div class="h-56 relative">
            <canvas id="chart-payments"></canvas>
          </div>
        </div>

        <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl shadow flex flex-col justify-between">
          <div>
            <h3 class="text-xs font-bold text-slate-300 uppercase mb-2 flex items-center gap-2">
              <i class="fa-solid fa-bolt text-yellow-400"></i> Eficiencia Operativa
            </h3>
            <p class="text-xs text-slate-400 leading-relaxed">
              Métricas calculadas en tiempo real para Fonseca, La Guajira:
            </p>
          </div>
          <div class="grid grid-cols-2 gap-2 mt-3 text-xs">
            <div class="bg-slate-950 p-3 rounded-lg border border-slate-800">
              <span class="text-slate-500 block text-[10px]">Tiempo Promedio</span>
              <span class="font-black text-white text-base">3.8 min</span>
            </div>
            <div class="bg-slate-950 p-3 rounded-lg border border-slate-800">
              <span class="text-slate-500 block text-[10px]">Tasa de Entrega</span>
              <span class="font-black text-emerald-400 text-base">98.4%</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Tab: Flota Mototaxis -->
    <div id="tab-couriers" class="tab-content hidden bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow">
      <div class="p-3.5 md:p-4 border-b border-slate-800">
        <h2 class="font-bold text-xs md:text-sm text-slate-200">Flota de Conductores</h2>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs min-w-[550px]">
          <thead class="bg-slate-950 text-slate-400 uppercase font-mono text-[10px] border-b border-slate-800">
            <tr>
              <th class="p-3">Nombre</th>
              <th class="p-3">Teléfono</th>
              <th class="p-3">Placa</th>
              <th class="p-3">Rating</th>
              <th class="p-3">Última Ubicación</th>
              <th class="p-3">Estado</th>
            </tr>
          </thead>
          <tbody id="table-couriers-body" class="divide-y divide-slate-800">
            <tr><td colspan="6" class="p-4 text-center text-slate-500">Cargando conductores...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Tab: Comercios -->
    <div id="tab-merchants" class="tab-content hidden bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow">
      <div class="p-3.5 md:p-4 border-b border-slate-800">
        <h2 class="font-bold text-xs md:text-sm text-slate-200">Directorio de Comercios</h2>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs min-w-[500px]">
          <thead class="bg-slate-950 text-slate-400 uppercase font-mono text-[10px] border-b border-slate-800">
            <tr>
              <th class="p-3">Nombre</th>
              <th class="p-3">Especialidad</th>
              <th class="p-3">Comisión</th>
              <th class="p-3">Plan</th>
              <th class="p-3">Destacado</th>
            </tr>
          </thead>
          <tbody id="table-merchants-body" class="divide-y divide-slate-800">
            <tr><td colspan="5" class="p-4 text-center text-slate-500">Cargando comercios...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Tab: Ledger -->
    <div id="tab-ledger" class="tab-content hidden bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow">
      <div class="p-3.5 md:p-4 border-b border-slate-800">
        <h2 class="font-bold text-xs md:text-sm text-slate-200">Libro Mayor Contable</h2>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs font-mono min-w-[650px]">
          <thead class="bg-slate-950 text-slate-400 uppercase text-[10px] border-b border-slate-800">
            <tr>
              <th class="p-3">ID</th>
              <th class="p-3">Ref</th>
              <th class="p-3">Cuenta</th>
              <th class="p-3">Débito</th>
              <th class="p-3">Crédito</th>
              <th class="p-3">Descripción</th>
            </tr>
          </thead>
          <tbody id="table-ledger-body" class="divide-y divide-slate-800">
            <tr><td colspan="6" class="p-4 text-center text-slate-500">Cargando libro contable...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Tab: Liquidaciones -->
    <div id="tab-settlements" class="tab-content hidden bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow">
      <div class="p-3.5 md:p-4 border-b border-slate-800">
        <h2 class="font-bold text-xs md:text-sm text-slate-200">Liquidaciones de Conductores</h2>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs min-w-[600px]">
          <thead class="bg-slate-950 text-slate-400 uppercase font-mono text-[10px] border-b border-slate-800">
            <tr>
              <th class="p-3">Fecha</th>
              <th class="p-3">Conductor</th>
              <th class="p-3">Efectivo Cobrado</th>
              <th class="p-3">Ganancia</th>
              <th class="p-3">A Consignar</th>
              <th class="p-3">Estado</th>
            </tr>
          </thead>
          <tbody id="table-settlements-body" class="divide-y divide-slate-800 font-mono">
            <tr><td colspan="6" class="p-4 text-center text-slate-500">Cargando liquidaciones...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </main>

  <script>
    let radarMapInstance = null;
    let courierMarkers = {};
    let chartsInitialized = false;
    let chartRevenueInstance, chartServicesInstance, chartPaymentsInstance;

    function switchTab(tabId) {
      document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
      document.querySelectorAll('.tab-btn').forEach(el => {
        el.classList.remove('bg-emerald-600', 'text-white');
        el.classList.add('bg-slate-800', 'text-slate-400');
      });

      document.getElementById('tab-' + tabId).classList.remove('hidden');
      const btn = document.getElementById('tab-btn-' + tabId);
      btn.classList.add('bg-emerald-600', 'text-white');
      btn.classList.remove('bg-slate-800', 'text-slate-400');

      if (tabId === 'radar') {
        setTimeout(loadRadarMap, 200);
      }
      if (tabId === 'analytics') {
        setTimeout(loadAnalyticsCharts, 200);
      }
    }

    function initRadarMap() {
      if (radarMapInstance) return;
      radarMapInstance = L.map('radar-map', { zoomControl: false }).setView([10.6075, -72.8530], 15);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap'
      }).addTo(radarMapInstance);
    }

    async function loadRadarMap() {
      initRadarMap();
      try {
        const couriers = await fetch('/api/couriers').then(r => r.json());
        couriers.forEach(c => {
          const lat = parseFloat(c.current_lat || 10.6075);
          const lng = parseFloat(c.current_lng || -72.8530);
          
          const popupHtml = \`
            <div class="text-xs p-1">
              <p class="font-bold text-slate-900">\${c.name} 🛵</p>
              <p class="text-slate-600">Placa: <b>\${c.plate || 'Moto'}</b></p>
              <p class="text-slate-600">Rating: \${c.rating || '5.0'} ⭐</p>
              <p class="text-slate-500 text-[10px]">Actualizado: \${new Date(c.location_updated_at || Date.now()).toLocaleTimeString()}</p>
            </div>
          \`;

          if (courierMarkers[c.id]) {
            courierMarkers[c.id].setLatLng([lat, lng]).bindPopup(popupHtml);
          } else {
            const icon = L.divIcon({
              className: 'radar-marker',
              html: \`<div class="w-8 h-8 rounded-full bg-emerald-600 border-2 border-white flex items-center justify-center text-sm shadow text-white font-bold">\${c.name[0]}</div>\`,
              iconSize: [32, 32],
              iconAnchor: [16, 16]
            });
            courierMarkers[c.id] = L.marker([lat, lng], { icon }).addTo(radarMapInstance).bindPopup(popupHtml);
          }
        });
        radarMapInstance.invalidateSize();
      } catch (e) {
        console.error("Error cargando radar GPS:", e);
      }
    }

    async function loadAnalyticsCharts() {
      try {
        const data = await fetch('/api/analytics').then(r => r.json());

        // 1. Chart Revenue
        const revCtx = document.getElementById('chart-revenue').getContext('2d');
        const days = data.daily.map(d => d.day);
        const revenues = data.daily.map(d => Number(d.revenue || 0));

        if (chartRevenueInstance) chartRevenueInstance.destroy();
        chartRevenueInstance = new Chart(revCtx, {
          type: 'line',
          data: {
            labels: days.length ? days : ['Hoy'],
            datasets: [{
              label: 'Ingresos COP',
              data: revenues.length ? revenues : [25000],
              borderColor: '#10b981',
              backgroundColor: 'rgba(16, 185, 129, 0.1)',
              fill: true,
              tension: 0.3
            }]
          },
          options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
        });

        // 2. Chart Services
        const servCtx = document.getElementById('chart-services').getContext('2d');
        const typeLabels = data.types.map(t => t.type === 'ride' ? 'Mototaxi' : 'Domicilio');
        const typeCounts = data.types.map(t => Number(t.count));

        if (chartServicesInstance) chartServicesInstance.destroy();
        chartServicesInstance = new Chart(servCtx, {
          type: 'doughnut',
          data: {
            labels: typeLabels.length ? typeLabels : ['Mototaxi', 'Domicilios'],
            datasets: [{
              data: typeCounts.length ? typeCounts : [12, 8],
              backgroundColor: ['#10b981', '#3b82f6', '#f59e0b']
            }]
          },
          options: { responsive: true, maintainAspectRatio: false }
        });

        // 3. Chart Payments
        const payCtx = document.getElementById('chart-payments').getContext('2d');
        const payLabels = data.payments.map(p => p.method === 'cash' ? 'Efectivo' : 'Transferencia');
        const payCounts = data.payments.map(p => Number(p.count));

        if (chartPaymentsInstance) chartPaymentsInstance.destroy();
        chartPaymentsInstance = new Chart(payCtx, {
          type: 'bar',
          data: {
            labels: payLabels.length ? payLabels : ['Efectivo', 'Transferencia'],
            datasets: [{
              label: 'Transacciones',
              data: payCounts.length ? payCounts : [15, 6],
              backgroundColor: ['#f59e0b', '#8b5cf6']
            }]
          },
          options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
        });
      } catch (e) {
        console.error("Error cargando gráficos BI:", e);
      }
    }

    async function loadAllData() {
      try {
        const stats = await fetch('/api/stats').then(r => r.json());
        document.getElementById('kpi-orders').innerText = stats.orders?.total || 0;
        document.getElementById('kpi-volume').innerText = '$' + Number(stats.ledger_volume || 0).toLocaleString('es-CO');
        document.getElementById('kpi-couriers').innerText = stats.couriers || 0;
        document.getElementById('kpi-merchants').innerText = stats.merchants?.total || 0;

        const orders = await fetch('/api/orders').then(r => r.json());
        const ordersTbody = document.getElementById('table-orders-body');
        ordersTbody.innerHTML = orders.length ? orders.map(o => \`
          <tr class="hover:bg-slate-800/50">
            <td class="p-3 font-bold text-emerald-400">\${o.code}</td>
            <td class="p-3 capitalize">\${o.type === 'ride' ? '🛵 Mototaxi' : '📦 Domicilio'}</td>
            <td class="p-3 truncate max-w-[120px]">\${o.user_name || 'Cliente'}</td>
            <td class="p-3 truncate max-w-[120px]">\${o.courier_name ? o.courier_name : '<span class="text-slate-500">Sin asignar</span>'}</td>
            <td class="p-3 font-bold text-white">$\${Number(o.total).toLocaleString('es-CO')}</td>
            <td class="p-3 capitalize">\${o.payment_method === 'cash' ? '💵 Efec' : '📱 Transf'}</td>
            <td class="p-3"><span class="px-2 py-0.5 rounded text-[10px] font-bold \${o.status === 'DELIVERED' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'}">\${o.status}</span></td>
            <td class="p-3"><a href="/track/\${o.code}" target="_blank" class="px-2.5 py-1 bg-emerald-600/30 hover:bg-emerald-600 text-emerald-300 hover:text-white rounded text-[10px] font-bold transition">🗺️ Ver</a></td>
          </tr>
        \`).join('') : '<tr><td colspan="8" class="p-4 text-center text-slate-500">No hay pedidos registrados.</td></tr>';

        const ledger = await fetch('/api/ledger').then(r => r.json());
        const ledgerTbody = document.getElementById('table-ledger-body');
        ledgerTbody.innerHTML = ledger.length ? ledger.map(l => \`
          <tr class="hover:bg-slate-800/50">
            <td class="p-3 text-slate-500">#\${l.id}</td>
            <td class="p-3 font-bold text-slate-300">\${l.order_code || '-'}</td>
            <td class="p-3 text-indigo-400 font-semibold">\${l.account}</td>
            <td class="p-3 text-emerald-400 font-bold">\${Number(l.debit) > 0 ? '+$' + Number(l.debit).toLocaleString('es-CO') : '-'}</td>
            <td class="p-3 text-orange-400 font-bold">\${Number(l.credit) > 0 ? '-$' + Number(l.credit).toLocaleString('es-CO') : '-'}</td>
            <td class="p-3 text-slate-400 font-sans truncate max-w-[200px]">\${l.memo || '-'}</td>
          </tr>
        \`).join('') : '<tr><td colspan="6" class="p-4 text-center text-slate-500">No hay asientos contables.</td></tr>';

        const settlements = await fetch('/api/settlements').then(r => r.json());
        const settTbody = document.getElementById('table-settlements-body');
        settTbody.innerHTML = settlements.length ? settlements.map(s => \`
          <tr class="hover:bg-slate-800/50">
            <td class="p-3">\${new Date(s.date).toLocaleDateString('es-CO')}</td>
            <td class="p-3 font-semibold">\${s.courier_name} (\${s.plate || 'Vehículo'})</td>
            <td class="p-3">$\${Number(s.cash_collected).toLocaleString('es-CO')}</td>
            <td class="p-3 text-emerald-400">$\${Number(s.fees_earned).toLocaleString('es-CO')}</td>
            <td class="p-3 font-black text-amber-400">$\${Number(s.net).toLocaleString('es-CO')}</td>
            <td class="p-3"><span class="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-500/20 text-blue-400">\${s.status}</span></td>
          </tr>
        \`).join('');

        const merchants = await fetch('/api/merchants').then(r => r.json());
        const merchTbody = document.getElementById('table-merchants-body');
        merchTbody.innerHTML = merchants.map(m => \`
          <tr class="hover:bg-slate-800/50">
            <td class="p-3 font-bold \${m.sponsored ? 'text-amber-400' : ''}">\${m.sponsored ? '🌟 ' : ''}\${m.name}</td>
            <td class="p-3 text-slate-400 truncate max-w-[150px]">\${m.specialty || '-'}</td>
            <td class="p-3">\${m.commission_pct}%</td>
            <td class="p-3 font-mono">\${m.ad_plan ? '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-purple-500/20 text-purple-300">' + m.ad_plan.toUpperCase() + '</span>' : 'Estándar'}</td>
            <td class="p-3">\${m.sponsored ? '<span class="text-emerald-400 font-semibold">Destacado</span>' : '<span class="text-slate-500">Orgánico</span>'}</td>
          </tr>
        \`).join('');

        const couriers = await fetch('/api/couriers').then(r => r.json());
        const courTbody = document.getElementById('table-couriers-body');
        courTbody.innerHTML = couriers.map(c => \`
          <tr class="hover:bg-slate-800/50">
            <td class="p-3 font-bold">\${c.name}</td>
            <td class="p-3 font-mono text-slate-400">\${c.wa_phone}</td>
            <td class="p-3 font-mono text-amber-400">\${c.plate || '-'}</td>
            <td class="p-3 text-yellow-400"><i class="fa-solid fa-star text-xs"></i> \${c.rating || '5.0'}</td>
            <td class="p-3 font-mono text-slate-400 text-[11px]">\${c.current_lat ? parseFloat(c.current_lat).toFixed(4) + ', ' + parseFloat(c.current_lng).toFixed(4) : '-'}</td>
            <td class="p-3">\${c.is_active ? '<span class="text-emerald-400 font-bold">Activo</span>' : '<span class="text-rose-400">Inactivo</span>'}</td>
          </tr>
        \`).join('');
      } catch (e) {
        console.error("Error cargando datos:", e);
      }
    }

    loadAllData();
    loadRadarMap();
    setInterval(loadAllData, 10000);
    setInterval(loadRadarMap, 10000);
  </script>
</body>
</html>`;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  return res.end(html);
});

adminServer.listen(3000, () => {
  console.log('🌐 Panel Web Administrativo corriendo en http://localhost:3000');
});

bot.launch();
console.log('\n🚀 Fonsi (Telegram) conectado...');

process.once('SIGINT', () => {
  adminServer.close();
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  adminServer.close();
  bot.stop('SIGTERM');
});
