import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  WAMessage
} from '@whiskeysockets/baileys';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { Pool } from 'pg';
import Redis from 'ioredis';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

dotenv.config();

console.log('🚀 Iniciando Fonsi 2x3 WhatsApp (Reconocimiento por Número, Turnos Diurno/Nocturno, Gemini 2.5 Flash)...');

// Conexión a PostgreSQL (compartida con el ecosistema Fonsi 2x3)
const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5435', 10),
  user: process.env.DB_USER || 'fonsi_user',
  password: process.env.DB_PASSWORD || 'fonsi_password',
  database: process.env.DB_NAME || 'en_un_2x3'
});

// Conexión a Redis
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

const WORKSPACE_PATH = process.env.WORKSPACE_PATH || '/root/en-un-2x3/workspace-fonsi';
const ADMIN_NUMBERS = (process.env.ADMIN_WHATSAPP_NUMBERS || '573506811888')
  .split(',')
  .map(s => s.replace(/\D/g, ''))
  .filter(Boolean);

let latestQR: string | null = null;
let connectionStatus: 'connecting' | 'qr_ready' | 'connected' | 'disconnected' = 'connecting';
let activeSock: ReturnType<typeof makeWASocket> | null = null;

// Estado en memoria para flujos de registro rápido y conversaciones
interface OnboardingState {
  step: 'name' | 'service_type' | 'shift_type' | 'plate';
  name?: string;
  serviceType?: 'mototaxi' | 'domicilio';
  shiftType?: 'diurno' | 'nocturno';
}
const registrationSessions = new Map<string, OnboardingState>();
const chatHistories = new Map<string, Array<{ role: string; content: string }>>();

// Utilidad para extraer los últimos 10 dígitos del número de WhatsApp (formato Colombia)
function extractLocalPhone(jid: string): string {
  const digits = (jid.split('@')[0] || '').replace(/\D/g, '');
  if (digits.length > 10 && digits.startsWith('57')) {
    return digits.slice(2, 12);
  }
  return digits.slice(-10);
}

// Formateador de texto a estilo WhatsApp limpio
function formatWhatsAppText(text: string): string {
  if (!text) return '';
  return text
    .replace(/<b>(.*?)<\/b>/gi, '*$1*')
    .replace(/<strong>(.*?)<\/strong>/gi, '*$1*')
    .replace(/<i>(.*?)<\/i>/gi, '_$1_')
    .replace(/<code>(.*?)<\/code>/gi, '```$1```')
    .replace(/\*\*(.*?)\*\*/g, '*$1*')
    .replace(/<[^>]+>/g, '');
}

// Buscar si el número corresponde a un conductor o domiciliario registrado
async function findCourierByPhone(localPhone: string) {
  if (!localPhone || localPhone.length < 7) return null;
  try {
    const res = await pool.query(
      `SELECT id, name, phone, status, vehicle_type, plate,
              COALESCE(service_type, 'mototaxi') AS service_type,
              COALESCE(shift_type, 'diurno') AS shift_type
       FROM couriers
       WHERE REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE '%' || $1
       LIMIT 1`,
      [localPhone]
    );
    return res.rows[0] || null;
  } catch (err) {
    console.error('Error consultando conductor por teléfono:', err);
    return null;
  }
}

// Despacho inteligente con ponderación de solape (5:00 PM - 8:00 PM prioriza nocturnos frescos)
async function selectBestCourierForDispatch(requiredService: 'mototaxi' | 'domicilio') {
  const nowColombia = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
  const hour = nowColombia.getHours();
  const isOverlapWindow = hour >= 17 && hour < 20; // 5:00 PM a 7:59 PM
  const isNightWindow = hour >= 20 || hour < 6;    // 8:00 PM a 5:59 AM

  let shiftOrderClause = `CASE WHEN COALESCE(shift_type, 'diurno') = 'diurno' THEN 0 ELSE 1 END`;
  if (isOverlapWindow || isNightWindow) {
    // Al caer la tarde y en la noche, los nocturnos entran frescos y tienen prioridad
    shiftOrderClause = `CASE WHEN COALESCE(shift_type, 'diurno') = 'nocturno' THEN 0 ELSE 1 END`;
  }

  const res = await pool.query(
    `SELECT id, name, phone, telegram_id,
            COALESCE(service_type, 'mototaxi') AS service_type,
            COALESCE(shift_type, 'diurno') AS shift_type
     FROM couriers
     WHERE status = 'available'
       AND (COALESCE(service_type, 'mototaxi') = $1 OR COALESCE(service_type, 'ambos') = 'ambos')
     ORDER BY ${shiftOrderClause} ASC, RANDOM()
     LIMIT 1`,
    [requiredService]
  );
  return res.rows[0] || null;
}

// Menú para Clientes (o Conductores fuera de servicio)
function buildClientMenu(name: string, isOfflineCourier: boolean, courierShift?: string): string {
  let msg = `👋 *¡Qué hubo ${name || 'vecino'}! Soy Fonsi, tu asistente en Fonseca en un 2x3.*\n\n`;
  msg += `¿Qué necesitas hacer hoy? Escribe el *número* o dime con tus palabras (o en nota de voz 🎤):\n\n`;
  msg += `1️⃣ 🍔 *Pedir Domicilio* (Restaurantes, farmacias o compras)\n`;
  msg += `2️⃣ 🛵 *Pedir Mototaxi Urbano* (Tarifa fija $3.000)\n`;
  msg += `3️⃣ 🚗 *Viaje Intermunicipal* (San Juan, Barrancas, Distracción, Riohacha)\n`;
  msg += `4️⃣ 📦 *Consultar estado de mi pedido*\n`;
  msg += `5️⃣ 💳 *Enviar comprobante de pago* (Bre-B: *@3506811888*)\n`;

  if (isOfflineCourier) {
    msg += `\n────────────────────\n`;
    msg += `🪖 _Reconocí tu número de aliado (${courierShift?.toUpperCase() || 'DIURNO'}). Como estás fuera de turno te muestro el menú de cliente._\n`;
    msg += `👉 _Escribe *#turno* cuando quieras activarte a recibir servicios._`;
  }
  return msg;
}

// Menú para Conductores / Domiciliarios Activos en Turno
function buildActiveCourierMenu(courier: any): string {
  const rol = courier.service_type === 'domicilio' ? '📦 Domiciliario' : '🛵 Mototaxista';
  const turno = courier.shift_type === 'nocturno' ? '🌙 Nocturno' : '☀️ Diurno';
  const estado = courier.status === 'available' ? '🟢 Disponible' : '🟡 Ocupado en carrera';

  return (
    `🪖 *PANEL DE CONDUCTOR ACTIVO - FONSI 2X3*\n` +
    `👤 *Nombre:* ${courier.name}\n` +
    `🏷️ *Rol:* ${rol} | *Turno:* ${turno}\n` +
    `📡 *Estado:* ${estado}\n\n` +
    `Escribe el comando o número rápido:\n` +
    `• *#pedidos* — Ver mis servicios activos\n` +
    `• *#entregado* — Marcar servicio actual como completado\n` +
    `• *#cuadre* — Ver mi ganado hoy y cuota ($2.000/día)\n` +
    `• *#diurno* o *#nocturno* — Cambiar mi perfil de horario\n` +
    `• *#descansar* — Cerrar turno (pasar a modo Cliente normal)`
  );
}

// Transcripción y comprensión de Audio con Gemini 2.5 Flash
async function transcribeAudioBuffer(buffer: Buffer, mimeType: string): Promise<string | null> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) return null;
  try {
    const base64Audio = buffer.toString('base64');
    const cleanMime = mimeType.split(';')[0].trim() || 'audio/ogg';
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: 'Transcribe exactamente este audio enviado por un usuario en Fonseca, La Guajira. Devuelve únicamente el texto transcrito sin explicaciones.'
                },
                {
                  inlineData: {
                    mimeType: cleanMime,
                    data: base64Audio
                  }
                }
              ]
            }
          ]
        })
      }
    );
    const data: any = await resp.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch (err) {
    console.error('Error transcribiendo nota de voz:', err);
    return null;
  }
}

// Analizador OCR de Comprobantes de Pago con Few-Shot Learning
async function analyzeReceiptBuffer(buffer: Buffer, mimeType: string): Promise<any> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) return null;

  let fewShotPrompt = '';
  try {
    const datasetPath = path.join(WORKSPACE_PATH, 'dataset_recibos.json');
    if (fs.existsSync(datasetPath)) {
      const examples = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
      if (Array.isArray(examples) && examples.length > 0) {
        fewShotPrompt = `\nEjemplos reales validados previamente:\n${JSON.stringify(examples.slice(-8), null, 2)}\n`;
      }
    }
  } catch {}

  try {
    const base64Img = buffer.toString('base64');
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text:
                    `Analiza esta imagen. Determina si es un comprobante de transferencia bancaria o billetera digital (Nequi, Bancolombia, Daviplata, Bre-B). ` +
                    `Extrae en formato JSON estricto: {"es_comprobante": boolean, "banco": string, "monto": number, "referencia": string, "destino": string, "fecha": string, "es_valido": boolean}. ` +
                    `Ten en cuenta que la llave oficial Bre-B de Fonsi es @3506811888.${fewShotPrompt}`
                },
                {
                  inlineData: {
                    mimeType: mimeType || 'image/jpeg',
                    data: base64Img
                  }
                }
              ]
            }
          ]
        })
      }
    );
    const data: any = await resp.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch (err) {
    console.error('Error en OCR de comprobante:', err);
    return null;
  }
}

// Configuración de Campañas / Instrucciones por Temporada y Activación de Marca
interface CampaignConfig {
  activa: boolean;
  nombre: string;
  frase_clave: string;
  respuesta_directa: string;
  instrucciones_ia: string;
  actualizado_en: string;
}

const CAMPAIGN_FILE = path.join(WORKSPACE_PATH, 'campana_activa.json');
const ACTIVATIONS_LOG_FILE = path.join(WORKSPACE_PATH, 'activaciones_registradas.json');

function loadActiveCampaign(): CampaignConfig {
  const defaultCampaign: CampaignConfig = {
    activa: false,
    nombre: 'Jornada de Activación de Marca Fonsi 2x3',
    frase_clave: 'quiero activarme',
    respuesta_directa:
      '🎉 *¡ESO ES TODO PRIMO! Bienvenido a la Jornada de Activación de Fonsi 2x3 en Fonseca.*\n\n' +
      '🎁 Tu número ya quedó pre-registrado en nuestra activación de marca.\n\n' +
      '👉 Respóndeme con tu *Nombre y tu Barrio en Fonseca* para completar tu activación y darte tu beneficio del día:',
    instrucciones_ia:
      'HOY ESTAMOS EN JORNADA ESPECIAL DE ACTIVACIÓN DE MARCA DE FONSI 2X3 EN FONSECA. ' +
      'Si el cliente menciona que quiere activarse o te da su nombre y barrio tras el mensaje de activación, ' +
      'felicítalo con mucho entusiasmo guajiro, confírmale que ya quedó 100% ACTIVADO con Fonsi 2x3 y recuérdale que tiene domicilios en un 2x3 y mototaxi urbano a $3.000.',
    actualizado_en: new Date().toISOString()
  };

  try {
    if (fs.existsSync(CAMPAIGN_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CAMPAIGN_FILE, 'utf8'));
      return { ...defaultCampaign, ...parsed };
    }
  } catch (err) {
    console.error('Error leyendo campana_activa.json:', err);
  }
  return defaultCampaign;
}

function saveActiveCampaign(config: CampaignConfig) {
  try {
    config.actualizado_en = new Date().toISOString();
    fs.writeFileSync(CAMPAIGN_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('Error guardando campana_activa.json:', err);
  }
}

function registerActivationParticipant(phone: string, name: string, message: string, campaignName: string) {
  try {
    let list: Array<any> = [];
    if (fs.existsSync(ACTIVATIONS_LOG_FILE)) {
      list = JSON.parse(fs.readFileSync(ACTIVATIONS_LOG_FILE, 'utf8'));
      if (!Array.isArray(list)) list = [];
    }
    list.unshift({
      telefono: phone,
      nombre_whatsapp: name,
      mensaje: message,
      campana: campaignName,
      fecha: new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })
    });
    fs.writeFileSync(ACTIVATIONS_LOG_FILE, JSON.stringify(list.slice(0, 1000), null, 2), 'utf8');
  } catch (err) {
    console.error('Error guardando participante de activación:', err);
  }
}

function getActivationParticipants(): Array<any> {
  try {
    if (fs.existsSync(ACTIVATIONS_LOG_FILE)) {
      const list = JSON.parse(fs.readFileSync(ACTIVATIONS_LOG_FILE, 'utf8'));
      return Array.isArray(list) ? list : [];
    }
  } catch {}
  return [];
}

// Motor Conversacional IA (Gemini 2.5 Flash + Contexto PostgreSQL en vivo + Temporada/Campaña)
async function askFonsiAI(senderPhone: string, userName: string, userMessage: string, courier: any): Promise<string> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    return '⚠️ El motor de IA no tiene configurada la llave LLM_API_KEY.';
  }

  let fonsiSoul = 'Eres Fonsi, el asistente virtual líder de Fonseca, La Guajira ("En un 2x3"). Hablas cálido, claro, conciso y servicial.';
  try {
    const soulPath = path.join(WORKSPACE_PATH, 'SOUL.md');
    if (fs.existsSync(soulPath)) {
      fonsiSoul = fs.readFileSync(soulPath, 'utf8');
    }
  } catch {}

  let dbContext = '';
  try {
    const merchantsRes = await pool.query(
      `SELECT name, category, address, menu_json FROM merchants WHERE is_active = true LIMIT 15`
    );
    dbContext = merchantsRes.rows
      .map(m => `- ${m.name} (${m.category}): ${JSON.stringify(m.menu_json || {})}`)
      .join('\n');
  } catch {}

  const campaign = loadActiveCampaign();
  const campaignBlock =
    campaign.activa && campaign.instrucciones_ia
      ? `\n=== 🎯 INSTRUCCIÓN ESPECIAL DE TEMPORADA / CAMPAÑA ACTIVA HOY (${campaign.nombre}) ===\n` +
        `PRIORIDAD MÁXIMA HOY: ${campaign.instrucciones_ia}\n` +
        `Frase clave de la jornada: "${campaign.frase_clave}"\n====================================================================\n`
      : '';

  const roleNote =
    courier && (courier.status === 'available' || courier.status === 'busy')
      ? `El usuario actual ES CONDUCTOR ACTIVO EN TURNO (${courier.service_type}, turno ${courier.shift_type}).`
      : `El usuario actual está en MODO CLIENTE (Teléfono WhatsApp: ${senderPhone}, Nombre: ${userName}).`;

  const rulesPrompt = `
${campaignBlock}
REGLAS ESTRICTAS DE NEGOCIO FONSI 2X3 (WHATSAPP):
1. Mototaxi urbano en Fonseca: tarifa plana de $3.000 COP. El 100% es para el mototaxista (paga $2.000/día de suscripción).
2. Domicilios urbanos: 1 parada $3.000 ($2.000 domiciliario / $1.000 Fonsi), 2 paradas $5.000 ($3.500 / $1.500), 3 paradas $8.000 ($6.000 / $2.000).
3. Restaurantes aliados: 0% comisión (reciben el 100% del valor de su comida).
4. Viajes intermunicipales en carro enrutados por Fonsi: comisión de $4.000 COP por pasajero para Fonsi.
5. Pagos por transferencia: usar exclusivamente la llave Bre-B *@3506811888* o Efectivo contra entrega.
6. Sé breve, directo (máximo 4-5 líneas por respuesta) y usa formato de WhatsApp (*negrita*).
${roleNote}`;

  const history = chatHistories.get(senderPhone) || [];
  history.push({ role: 'user', content: userMessage });
  if (history.length > 10) history.splice(0, history.length - 10);

  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.LLM_MODEL || 'gemini-2.5-flash',
        messages: [
          { role: 'system', content: `${fonsiSoul}\n\nCOMERCIOS ACTIVOS:\n${dbContext}\n\n${rulesPrompt}` },
          ...history
        ],
        temperature: 0.4
      })
    });

    const data: any = await response.json();
    const reply = data?.choices?.[0]?.message?.content || '¡Listo primo! ¿Me confirmas tu dirección exacta en Fonseca?';
    history.push({ role: 'assistant', content: reply });
    chatHistories.set(senderPhone, history);
    return formatWhatsAppText(reply);
  } catch (err) {
    console.error('Error consultando Gemini:', err);
    return '¡Hermano! Tuve un parpadeo en la señal, ¿me repites por favor?';
  }
}

// Notificar a los administradores por WhatsApp
async function notifyAdminsWhatsApp(text: string) {
  if (!activeSock) return;
  for (const adminNum of ADMIN_NUMBERS) {
    try {
      await activeSock.sendMessage(`${adminNum}@s.whatsapp.net`, { text: formatWhatsAppText(text) });
    } catch {}
  }
}

// Procesador central de mensajes entrantes de WhatsApp
async function handleIncomingMessage(sock: ReturnType<typeof makeWASocket>, msg: WAMessage) {
  if (!msg.message || msg.key.fromMe) return;
  const remoteJid = msg.key.remoteJid || '';
  if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') return;

  const localPhone = extractLocalPhone(remoteJid);
  const pushName = msg.pushName || 'Vecino';

  // 1. Extraer contenido (Texto, Audio/Nota de Voz, Imagen/Recibo, Ubicación GPS)
  let textContent =
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    msg.message.imageMessage?.caption ||
    '';

  // Manejo de Nota de Voz
  if (msg.message.audioMessage) {
    try {
      const buffer = (await downloadMediaMessage(msg, 'buffer', {})) as Buffer;
      const transcript = await transcribeAudioBuffer(buffer, msg.message.audioMessage.mimetype || 'audio/ogg');
      if (transcript) {
        textContent = transcript;
        await sock.sendMessage(remoteJid, { text: `🎤 _Escuché:_ "${transcript}"` });
      }
    } catch (e) {
      console.error('Fallo procesando audio:', e);
    }
  }

  // Manejo de Imagen (Comprobante de Pago OCR)
  if (msg.message.imageMessage) {
    try {
      await sock.sendMessage(remoteJid, { text: '🔍 *Verificando tu comprobante en un 2x3...*' });
      const buffer = (await downloadMediaMessage(msg, 'buffer', {})) as Buffer;
      const ocr = await analyzeReceiptBuffer(buffer, msg.message.imageMessage.mimetype || 'image/jpeg');
      if (ocr && ocr.es_comprobante) {
        const summary =
          `✅ *Comprobante Detectado*\n` +
          `🏦 *Entidad:* ${ocr.banco || 'Transferencia'}\n` +
          `💰 *Monto:* $${Number(ocr.monto || 0).toLocaleString('es-CO')} COP\n` +
          `🔢 *Ref:* ${ocr.referencia || 'N/A'}\n` +
          `🎯 *Destino:* ${ocr.destino || '@3506811888'}\n\n` +
          `¡Ya notificamos al comercio y a tu repartidor! 🚀`;
        await sock.sendMessage(remoteJid, { text: summary });
        await notifyAdminsWhatsApp(
          `💳 *NUEVO COMPROBANTE EN WHATSAPP*\nCliente: ${pushName} (${localPhone})\nMonto: $${ocr.monto}\nRef: ${ocr.referencia}`
        );
        return;
      }
    } catch (e) {
      console.error('Fallo procesando imagen:', e);
    }
  }

  // Manejo de Ubicación GPS
  if (msg.message.locationMessage) {
    const lat = msg.message.locationMessage.degreesLatitude;
    const lng = msg.message.locationMessage.degreesLongitude;
    const courier = await findCourierByPhone(localPhone);

    if (courier && (courier.status === 'available' || courier.status === 'busy')) {
      await redis.set(`courier:gps:${courier.id}`, JSON.stringify({ lat, lng, updatedAt: Date.now() }), 'EX', 3600);
      await sock.sendMessage(remoteJid, {
        text: `📍 *Ubicación de turno actualizada* (${lat?.toFixed(4)}, ${lng?.toFixed(4)}). ¡Seguimos activos!`
      });
      return;
    } else {
      textContent = `Mi ubicación GPS exacta es latitud ${lat}, longitud ${lng}.`;
    }
  }

  const clean = textContent.trim();
  if (!clean) return;
  const lower = clean.toLowerCase();

  // 2. Flujo de Registro de Nuevos Conductores / Domiciliarios (Oculto para clientes salvo que lo pidan)
  if (registrationSessions.has(localPhone)) {
    const state = registrationSessions.get(localPhone)!;
    if (lower === 'cancelar' || lower === '#cancelar') {
      registrationSessions.delete(localPhone);
      await sock.sendMessage(remoteJid, { text: '❌ Registro cancelado. Escribe *Hola* para ver el menú de cliente.' });
      return;
    }

    if (state.step === 'name') {
      state.name = clean;
      state.step = 'service_type';
      await sock.sendMessage(remoteJid, {
        text: `¡Mucho gusto *${state.name}*! ¿En qué modalidad vas a trabajar?\n\nResponde *1* o *2*:\n1️⃣ 🛵 *Mototaxi* (Transporte de pasajeros)\n2️⃣ 📦 *Domicilios* (Entregas de restaurantes y encargos)`
      });
      return;
    }

    if (state.step === 'service_type') {
      state.serviceType = lower.includes('2') || lower.includes('domicili') ? 'domicilio' : 'mototaxi';
      state.step = 'shift_type';
      await sock.sendMessage(remoteJid, {
        text: `Perfecto (*${state.serviceType.toUpperCase()}*). ¿Cuál es tu horario principal?\n\nResponde *1* o *2*:\n1️⃣ ☀️ *Turno Diurno* (6:00 AM - 5:30 PM)\n2️⃣ 🌙 *Turno Nocturno* (5:00 PM - 11:30 PM, con prioridad en el solape de la tarde)`
      });
      return;
    }

    if (state.step === 'shift_type') {
      state.shiftType = lower.includes('2') || lower.includes('nocturn') || lower.includes('noche') ? 'nocturno' : 'diurno';
      state.step = 'plate';
      await sock.sendMessage(remoteJid, {
        text: `Excelente (*Turno ${state.shiftType}*). Por último, escribe la *placa de tu moto* y color (ej: _ABC12D Negra_):`
      });
      return;
    }

    if (state.step === 'plate') {
      const plate = clean.toUpperCase();
      try {
        await pool.query(
          `INSERT INTO couriers (name, phone, status, vehicle_type, plate, service_type, shift_type)
           VALUES ($1, $2, 'available', 'moto', $3, $4, $5)`,
          [state.name, localPhone, plate, state.serviceType, state.shiftType]
        );
        registrationSessions.delete(localPhone);
        const newCourier = await findCourierByPhone(localPhone);
        await sock.sendMessage(remoteJid, {
          text:
            `🎉 *¡Quedaste afiliado y ACTIVO en Fonsi 2x3!*\n\n` +
            `Ya reconocemos tu número *${localPhone}* automáticamente.\n` +
            `• Cuando estés *activo en turno*, verás tu panel de trabajo.\n` +
            `• Cuando escribas *#descansar*, verás el menú normal de cliente.\n\n` +
            buildActiveCourierMenu(newCourier)
        });
        await notifyAdminsWhatsApp(
          `🪖 *NUEVO CONDUCTOR REGISTRADO EN WHATSAPP*\nNombre: ${state.name}\nTel: ${localPhone}\nRol: ${state.serviceType}\nTurno: ${state.shiftType}\nPlaca: ${plate}`
        );
      } catch (e) {
        console.error('Error guardando conductor:', e);
        registrationSessions.delete(localPhone);
        await sock.sendMessage(remoteJid, { text: '⚠️ Hubo un error registrando tus datos. Intenta de nuevo con *#registrar conductor*.' });
      }
      return;
    }
  }

  // Comando explícito para afiliarse como conductor
  if (lower === '#registrar conductor' || lower === 'registrarme como conductor' || lower === '#afiliarme') {
    const existing = await findCourierByPhone(localPhone);
    if (existing) {
      await sock.sendMessage(remoteJid, {
        text: `✅ Tu número *${localPhone}* ya está registrado como *${existing.name}* (${existing.service_type} - ${existing.shift_type}). Escribe *#turno* para entrar en servicio.`
      });
      return;
    }
    registrationSessions.set(localPhone, { step: 'name' });
    await sock.sendMessage(remoteJid, {
      text: `🪖 *AFILIACIÓN DE CONDUCTORES Y DOMICILIARIOS FONSI 2X3*\n\nTu número de WhatsApp (*${localPhone}*) quedará vinculado como tu identificador.\n\nPara empezar, escribe tu *Nombre y Apellido* (o escribe _cancelar_):`
    });
    return;
  }

  // 3. Reconocimiento automático por número de teléfono
  const courier = await findCourierByPhone(localPhone);

  // Comandos de control de turno para conductores registrados
  if (courier) {
    if (lower === '#turno' || lower === 'activar turno' || lower === 'modo conductor') {
      await pool.query(`UPDATE couriers SET status = 'available' WHERE id = $1`, [courier.id]);
      courier.status = 'available';
      await sock.sendMessage(remoteJid, {
        text: `🟢 *¡Turno activado, ${courier.name}!* Ya estás disponible para recibir servicios.\n\n` + buildActiveCourierMenu(courier)
      });
      return;
    }

    if (lower === '#descansar' || lower === 'cerrar turno' || lower === 'modo cliente') {
      await pool.query(`UPDATE couriers SET status = 'offline' WHERE id = $1`, [courier.id]);
      courier.status = 'offline';
      await sock.sendMessage(remoteJid, {
        text:
          `🔴 *Turno cerrado.* Has pasado a *Modo Cliente*.\n` +
          `Ahora puedes pedir comida o carreras como cualquier usuario.\n\n` +
          buildClientMenu(courier.name, true, courier.shift_type)
      });
      return;
    }

    if (lower === '#diurno' || lower === '#nocturno') {
      const newShift = lower.replace('#', '');
      await pool.query(`UPDATE couriers SET shift_type = $1 WHERE id = $2`, [newShift, courier.id]);
      courier.shift_type = newShift;
      await sock.sendMessage(remoteJid, {
        text: `🔄 Tu perfil de horario fue actualizado a *Turno ${newShift.toUpperCase()}*.`
      });
      return;
    }

    // Si el conductor está ACTIVO en servicio ('available' o 'busy'), procesar comandos de conductor
    if (courier.status === 'available' || courier.status === 'busy') {
      if (lower === 'hola' || lower === 'menu' || lower === 'menú' || lower === '#panel') {
        await sock.sendMessage(remoteJid, { text: buildActiveCourierMenu(courier) });
        return;
      }

      if (lower === '#cuadre' || lower === 'mi cuadre') {
        const ordersRes = await pool.query(
          `SELECT COUNT(*) AS total_servicios,
                  COALESCE(SUM(delivery_fee), 0) AS total_fletes
           FROM orders
           WHERE courier_id = $1
             AND status = 'delivered'
             AND created_at::date = CURRENT_DATE`,
          [courier.id]
        );
        const total = parseInt(ordersRes.rows[0]?.total_servicios || '0', 10);
        const cuota = total > 0 ? 2000 : 0;
        await sock.sendMessage(remoteJid, {
          text:
            `📊 *RESUMEN DEL DÍA - ${courier.name.toUpperCase()}*\n` +
            `• Servicios completados hoy: *${total}*\n` +
            `• Cuota de rodamiento hoy: *$${cuota.toLocaleString('es-CO')} COP*\n` +
            `• Llave para abonar cuota: *@3506811888* (Bre-B)`
        });
        return;
      }

      if (lower === '#entregado' || lower === 'entregado') {
        const upd = await pool.query(
          `UPDATE orders SET status = 'delivered'
           WHERE id = (
             SELECT id FROM orders
             WHERE courier_id = $1 AND status NOT IN ('delivered', 'cancelled')
             ORDER BY created_at DESC LIMIT 1
           ) RETURNING id, total_amount`,
          [courier.id]
        );
        await pool.query(`UPDATE couriers SET status = 'available' WHERE id = $1`, [courier.id]);
        if (upd.rows.length > 0) {
          await sock.sendMessage(remoteJid, {
            text: `✅ *Servicio #${upd.rows[0].id} marcado como ENTREGADO.* Ya quedaste 🟢 *Disponible* para el siguiente servicio.`
          });
        } else {
          await sock.sendMessage(remoteJid, {
            text: `ℹ️ No tenías servicios pendientes abiertos. Tu estado es 🟢 *Disponible*.`
          });
        }
        return;
      }
    }
  }

  // 3.5. Comandos de Administrador para Campañas / Temporadas (#campana on | #campana off | #campana estado)
  if (lower.startsWith('#campana') || lower.startsWith('#campaña')) {
    const campaign = loadActiveCampaign();
    const arg = clean.replace(/^#campa[ñn]a\s*/i, '').trim();

    if (arg.toLowerCase() === 'on' || arg.toLowerCase() === 'activar') {
      campaign.activa = true;
      saveActiveCampaign(campaign);
      await sock.sendMessage(remoteJid, {
        text:
          `🟢 *CAMPAÑA DE TEMPORADA ACTIVADA*\n` +
          `🏷️ *Nombre:* ${campaign.nombre}\n` +
          `🔑 *Frase disparadora:* "${campaign.frase_clave}"\n\n` +
          `🌐 Puedes editar los textos en vivo en:\nhttp://89.117.72.233:3005/campana`
      });
      return;
    }

    if (arg.toLowerCase() === 'off' || arg.toLowerCase() === 'apagar' || arg.toLowerCase() === 'desactivar') {
      campaign.activa = false;
      saveActiveCampaign(campaign);
      await sock.sendMessage(remoteJid, {
        text: `🔴 *Campaña de temporada DESACTIVADA.* Fonsi volvió a su comportamiento habitual del día a día.`
      });
      return;
    }

    const inscritos = getActivationParticipants().length;
    await sock.sendMessage(remoteJid, {
      text:
        `🎯 *ESTADO DE CAMPAÑA / TEMPORADA FONSI 2X3*\n` +
        `• Estado: *${campaign.activa ? '🟢 ACTIVA' : '🔴 INACTIVA'}*\n` +
        `• Nombre: *${campaign.nombre}*\n` +
        `• Frase clave: *"${campaign.frase_clave}"*\n` +
        `• Personas activadas registradas: *${inscritos}*\n\n` +
        `Comandos rápidos:\n` +
        `• *#campana on* — Encender campaña\n` +
        `• *#campana off* — Apagar campaña\n` +
        `• Panel web completo: http://89.117.72.233:3005/campana`
    });
    return;
  }

  // 3.6. Disparador de Campaña / Jornada de Activación de Marca (Ej: "Hola Fonsi quiero activarme")
  const activeCampaign = loadActiveCampaign();
  const normalizedInput = lower.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const normalizedTrigger = (activeCampaign.frase_clave || 'quiero activarme')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

  if (activeCampaign.activa && normalizedTrigger && normalizedInput.includes(normalizedTrigger)) {
    registerActivationParticipant(localPhone, pushName, clean, activeCampaign.nombre);
    await sock.sendMessage(remoteJid, {
      text: formatWhatsAppText(activeCampaign.respuesta_directa)
    });
    await notifyAdminsWhatsApp(
      `🎉 *NUEVA ACTIVACIÓN DE MARCA*\n👤 Nombre WhatsApp: ${pushName}\n📱 Teléfono: ${localPhone}\n💬 Mensaje: "${clean}"\n🏷️ Campaña: ${activeCampaign.nombre}`
    );
    return;
  }

  // 4. Si NO es conductor o el conductor está INACTIVO ('offline'), mostrar experiencia de CLIENTE
  const isOfflineCourier = Boolean(courier && courier.status === 'offline');

  if (lower === 'hola' || lower === 'buenas' || lower === 'menu' || lower === 'menú' || lower === 'inicio') {
    let menuText = buildClientMenu(courier?.name || pushName, isOfflineCourier, courier?.shift_type);
    if (activeCampaign.activa) {
      menuText += `\n\n🎁 *${activeCampaign.nombre}:* Escribe *"Hola Fonsi ${activeCampaign.frase_clave}"* para participar hoy.`;
    }
    await sock.sendMessage(remoteJid, { text: menuText });
    return;
  }

  // Atajos numéricos rápidos del menú de cliente
  if (clean === '1') {
    const reply = await askFonsiAI(localPhone, pushName, 'Quiero pedir un domicilio de comida o encargo, muéstrame los restaurantes aliados disponibles hoy.', courier);
    await sock.sendMessage(remoteJid, { text: reply });
    return;
  }

  if (clean === '2') {
    const assigned = await selectBestCourierForDispatch('mototaxi');
    let dispatchNote = '';
    if (assigned) {
      dispatchNote = `\n\n🛵 *Conductor pre-asignado cerca:* ${assigned.name} (Turno ${assigned.shift_type}).`;
    }
    await sock.sendMessage(remoteJid, {
      text:
        `🛵 *SOLICITAR MOTOTAXI URBANO ($3.000 COP)*\n\n` +
        `Por favor dime:\n` +
        `1. 📍 *¿En qué barrio o dirección te recogemos?*\n` +
        `2. 🏁 *¿Para dónde vas?*` +
        dispatchNote
    });
    return;
  }

  if (clean === '3') {
    await sock.sendMessage(remoteJid, {
      text:
        `🚗 *VIAJE INTERMUNICIPAL ENRUTADO*\n\n` +
        `Conectamos pasajeros hacia *San Juan del Cesar, Distracción, Barrancas, Hatonuevo y Riohacha*.\n` +
        `Dime: *¿Para qué municipio viajas, cuántos puestos necesitas y a qué hora?*`
    });
    return;
  }

  if (clean === '4') {
    const ordRes = await pool.query(
      `SELECT id, status, total_amount, created_at
       FROM orders
       WHERE customer_phone LIKE '%' || $1
       ORDER BY created_at DESC LIMIT 1`,
      [localPhone]
    );
    if (ordRes.rows.length > 0) {
      const o = ordRes.rows[0];
      await sock.sendMessage(remoteJid, {
        text: `📦 *Tu último servicio es el #${o.id}*\n• Estado: *${o.status.toUpperCase()}*\n• Total: *$${Number(o.total_amount || 0).toLocaleString('es-CO')} COP*`
      });
    } else {
      await sock.sendMessage(remoteJid, {
        text: `📦 No encontramos pedidos activos asociados a tu número *${localPhone}*. Escribe *1* para pedir un domicilio o *2* para un mototaxi.`
      });
    }
    return;
  }

  if (clean === '5') {
    await sock.sendMessage(remoteJid, {
      text:
        `💳 *PAGO RÁPIDO CON LLAVE BRE-B*\n\n` +
        `Transfiere desde Nequi, Bancolombia o Daviplata a nuestra llave oficial:\n` +
        `👉 *@3506811888*\n\n` +
        `Apenas hagas el pago, *envíame la foto o captura del comprobante por aquí* y lo valido en 2 segundos.`
    });
    return;
  }

  // 5. Conversación natural asistida por Gemini 2.5 Flash
  const aiResponse = await askFonsiAI(localPhone, courier?.name || pushName, clean, courier);
  await sock.sendMessage(remoteJid, { text: aiResponse });
}

// Inicialización de Baileys Multi-Device
async function startWhatsAppBot() {
  const authFolder = path.join(process.cwd(), 'auth_info_baileys');
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Fonsi 2x3 WhatsApp', 'Chrome', '1.0.0']
  });

  activeSock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', update => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      connectionStatus = 'qr_ready';
      console.log('\n📱 ESCANEA ESTE CÓDIGO QR EN TU WHATSAPP (Dispositivos Vinculados):');
      qrcode.generate(qr, { small: true });
      console.log(`🌐 También puedes ver el QR en tu navegador: http://89.117.72.233:${process.env.PORT || 3005}/qr\n`);
    }

    if (connection === 'close') {
      connectionStatus = 'disconnected';
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`⚠️ Conexión WhatsApp cerrada (código ${statusCode}). Reconectando: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(() => startWhatsAppBot(), 4000);
      }
    } else if (connection === 'open') {
      latestQR = null;
      connectionStatus = 'connected';
      console.log('✅ Fonsi 2x3 WhatsApp CONECTADO y escuchando mensajes en vivo.');
    }
  });

  sock.ev.on('messages.upsert', async m => {
    if (m.type !== 'notify') return;
    for (const msg of m.messages) {
      try {
        await handleIncomingMessage(sock, msg);
      } catch (err) {
        console.error('Error manejando mensaje WhatsApp:', err);
      }
    }
  });
}

// Servidor HTTP de salud, visor de código QR, cambio de línea y panel de Campañas/Temporadas
const port = parseInt(process.env.PORT || '3005', 10);
http
  .createServer(async (req, res) => {
    if (req.url === '/campana' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      req.on('end', () => {
        const params = new URLSearchParams(body);
        const current = loadActiveCampaign();
        current.activa = params.get('activa') === 'true';
        current.nombre = params.get('nombre') || current.nombre;
        current.frase_clave = params.get('frase_clave') || current.frase_clave;
        current.respuesta_directa = params.get('respuesta_directa') || current.respuesta_directa;
        current.instrucciones_ia = params.get('instrucciones_ia') || current.instrucciones_ia;
        saveActiveCampaign(current);
        res.writeHead(302, { Location: '/campana?saved=1' });
        res.end();
      });
      return;
    }

    if (req.url?.startsWith('/campana')) {
      const c = loadActiveCampaign();
      const participantes = getActivationParticipants();
      const savedBanner = req.url.includes('saved=1')
        ? `<div style="background:#2e7d32;color:#fff;padding:12px;border-radius:8px;margin-bottom:16px;">✅ ¡Configuración de temporada guardada y activa en tiempo real!</div>`
        : '';

      const rowsHtml =
        participantes.length === 0
          ? `<tr><td colspan="4" style="padding:12px;text-align:center;color:#888;">Aún no hay registros en esta jornada.</td></tr>`
          : participantes
              .slice(0, 50)
              .map(
                p =>
                  `<tr style="border-bottom:1px solid #333;">
                    <td style="padding:8px;">${p.fecha || ''}</td>
                    <td style="padding:8px;font-weight:bold;color:#4caf50;">${p.telefono || ''}</td>
                    <td style="padding:8px;">${p.nombre_whatsapp || ''}</td>
                    <td style="padding:8px;">${p.mensaje || ''}</td>
                  </tr>`
              )
              .join('');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <html>
          <head>
            <title>Panel de Temporadas y Activación - Fonsi 2x3</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
          </head>
          <body style="font-family:sans-serif;max-width:780px;margin:20px auto;padding:20px;background:#121212;color:#eee;">
            <h2>🎯 Panel de Temporadas y Activación de Marca — Fonsi 2x3</h2>
            <p style="color:#aaa;">Configura cómo responde Fonsi durante una jornada especial (sin tocar código ni reiniciar el bot).</p>
            ${savedBanner}
            <form method="POST" action="/campana" style="background:#1e1e1e;padding:20px;border-radius:12px;border:1px solid #333;">
              <label style="display:block;margin-bottom:14px;font-size:16px;">
                <strong>Estado de la Campaña:</strong><br/>
                <select name="activa" style="width:100%;padding:10px;margin-top:6px;border-radius:6px;background:#2c2c2c;color:#fff;border:1px solid #555;font-size:15px;">
                  <option value="true" ${c.activa ? 'selected' : ''}>🟢 ACTIVA (Fonsi responde en Modo Temporada / Activación)</option>
                  <option value="false" ${!c.activa ? 'selected' : ''}>🔴 INACTIVA (Fonsi responde en Modo Normal diario)</option>
                </select>
              </label>

              <label style="display:block;margin-bottom:14px;">
                <strong>Nombre de la Jornada / Temporada:</strong><br/>
                <input type="text" name="nombre" value="${c.nombre.replace(/"/g, '&quot;')}" style="width:100%;padding:10px;margin-top:6px;border-radius:6px;background:#2c2c2c;color:#fff;border:1px solid #555;" />
              </label>

              <label style="display:block;margin-bottom:14px;">
                <strong>🔑 Frase Clave Disparadora (ej: <em>quiero activarme</em>):</strong><br/>
                <small style="color:#aaa;">Si el usuario escribe "Hola Fonsi quiero activarme" (o cualquier frase que contenga estas palabras), Fonsi lo registra y dispara el mensaje especial.</small>
                <input type="text" name="frase_clave" value="${c.frase_clave.replace(/"/g, '&quot;')}" style="width:100%;padding:10px;margin-top:6px;border-radius:6px;background:#2c2c2c;color:#fff;border:1px solid #555;" />
              </label>

              <label style="display:block;margin-bottom:14px;">
                <strong>💬 Respuesta Inmediata al detectar la Frase Clave:</strong><br/>
                <textarea name="respuesta_directa" rows="4" style="width:100%;padding:10px;margin-top:6px;border-radius:6px;background:#2c2c2c;color:#fff;border:1px solid #555;">${c.respuesta_directa}</textarea>
              </label>

              <label style="display:block;margin-bottom:18px;">
                <strong>🧠 Instrucciones adicionales para la IA durante ese día:</strong><br/>
                <small style="color:#aaa;">Qué debe saber Gemini 2.5 Flash cuando siga conversando con la persona ese día.</small>
                <textarea name="instrucciones_ia" rows="4" style="width:100%;padding:10px;margin-top:6px;border-radius:6px;background:#2c2c2c;color:#fff;border:1px solid #555;">${c.instrucciones_ia}</textarea>
              </label>

              <button type="submit" style="background:#00c853;color:#000;font-weight:bold;padding:12px 24px;border:none;border-radius:8px;cursor:pointer;font-size:16px;width:100%;">
                💾 Guardar y Aplicar al Instante
              </button>
            </form>

            <h3 style="margin-top:32px;">📋 Personas Activadas (${participantes.length})</h3>
            <table style="width:100%;border-collapse:collapse;background:#1e1e1e;border-radius:8px;overflow:hidden;">
              <thead>
                <tr style="background:#2c2c2c;text-align:left;">
                  <th style="padding:10px;">Fecha / Hora</th>
                  <th style="padding:10px;">Teléfono</th>
                  <th style="padding:10px;">Nombre</th>
                  <th style="padding:10px;">Mensaje</th>
                </tr>
              </thead>
              <tbody>
                ${rowsHtml}
              </tbody>
            </table>
            <p style="text-align:center;margin-top:20px;"><a href="/qr" style="color:#4fc3f7;">&larr; Volver al Visor QR de WhatsApp</a></p>
          </body>
        </html>
      `);
      return;
    }

    if (req.url === '/reset-linea') {
      try {
        if (activeSock) {
          try {
            await activeSock.logout();
          } catch {}
        }
        const authFolder = path.join(process.cwd(), 'auth_info_baileys');
        fs.rmSync(authFolder, { recursive: true, force: true });
        latestQR = null;
        connectionStatus = 'connecting';
        setTimeout(() => startWhatsAppBot(), 1500);
      } catch (e) {
        console.error('Error reiniciando línea:', e);
      }
      res.writeHead(302, { Location: '/qr' });
      res.end();
      return;
    }

    if (req.url === '/qr') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (connectionStatus === 'connected') {
        res.end(`
          <html>
            <body style="font-family:sans-serif;text-align:center;padding:40px;background:#111;color:#fff;">
              <h1>✅ Fonsi 2x3 WhatsApp está Conectado</h1>
              <p>El bot está operando en vivo con la base de datos de Fonseca.</p>
              <br/>
              <a href="/reset-linea" onclick="return confirm('¿Seguro que deseas desvincular la línea actual y conectar un número nuevo?');"
                 style="background:#e53935;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">
                 🔄 Cambiar de Línea / Vincular otro Número
              </a>
            </body>
          </html>
        `);
      } else if (latestQR) {
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(latestQR)}`;
        res.end(`
          <html>
            <head><meta http-equiv="refresh" content="15"></head>
            <body style="font-family:sans-serif;text-align:center;padding:40px;background:#111;color:#fff;">
              <h2>📱 Escanea para vincular Fonsi 2x3 WhatsApp</h2>
              <p>Abre WhatsApp &rarr; Dispositivos vinculados &rarr; Vincular un dispositivo</p>
              <img src="${qrUrl}" style="background:#fff;padding:16px;border-radius:12px;" />
              <p><small>Estado: ${connectionStatus} (Se actualiza cada 15s)</small></p>
              <br/>
              <a href="/reset-linea" style="color:#aaa;font-size:13px;">🔄 Generar un QR nuevo desde cero</a>
            </body>
          </html>
        `);
      } else {
        res.end('<html><head><meta http-equiv="refresh" content="4"></head><body style="font-family:sans-serif;text-align:center;padding:40px;background:#111;color:#fff;"><h2>⏳ Generando código QR nuevo... espera 4 segundos</h2></body></html>');
      }
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ service: 'fonsi-2x3-wasap', status: connectionStatus, qrAvailable: Boolean(latestQR) }));
  })
  .listen(port, () => {
    console.log(`🌐 Monitor HTTP y Visor QR activo en puerto ${port} (/qr)`);
  });

startWhatsAppBot().catch(err => console.error('Error fatal al iniciar WhatsApp Bot:', err));
