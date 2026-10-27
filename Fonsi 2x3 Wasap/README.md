# 🛵 Fonsi 2x3 Wasap (Versión Oficial para WhatsApp)

Motor conversacional y logístico de **Fonsi ("En un 2x3")** para **Fonseca, La Guajira**, construido sobre `@whiskeysockets/baileys` (WhatsApp Multi-Device), **Gemini 2.5 Flash** (Voz + Visión OCR + Chat) y **PostgreSQL + Redis**.

Comparte en tiempo real la misma base de datos (`en_un_2x3`) y reglas contables que el núcleo de Telegram, permitiendo operación omnicanal.

---

## ✨ Características Principales

1. **Reconocimiento Automático por Número de Celular:**
   - En WhatsApp cada mensaje incluye el número real del remitente. Fonsi consulta instantáneamente la tabla `couriers`.
   - **Si es un conductor o domiciliario con turno ACTIVO (`available` / `busy`):** Fonsi despliega el **Panel de Conductor Activo** (`#pedidos`, `#entregado`, `#cuadre`, `#diurno`, `#nocturno`, `#descansar`).
   - **Si NO es conductor, o si es un conductor FUERA DE SERVICIO (`offline`):** Fonsi muestra el **Menú Limpio de Cliente** para que pueda pedir comida o mototaxi normalmente sin botones confusos.
2. **Perfiles Diurnos y Nocturnos con Solape Dinámico (5:00 PM - 8:00 PM):**
   - Soporta tanto **Mototaxis** como **Domiciliarios** en turnos `diurno` y `nocturno`.
   - Al caer la tarde (5:00 PM a 8:00 PM), el algoritmo de despacho prioriza automáticamente a los trabajadores **nocturnos** que entran frescos, usando a los diurnos aún activos como respaldo.
3. **Multimodalidad con Gemini 2.5 Flash:**
   - 🎤 **Notas de Voz (PTT):** Transcribe audios con jerga local fonsequera y procesa el pedido.
   - 📸 **Visión OCR de Recibos:** Valida comprobantes de Nequi, Bancolombia, Daviplata y Bre-B (`@3506811888`) con aprendizaje continuo (*Few-Shot Learning* desde `dataset_recibos.json`).
   - 📍 **Ubicación GPS:** Recibe pines de ubicación tanto de clientes como de repartidores en turno.
4. **Reglas Financieras Exactas:**
   - **Restaurantes aliados:** 0% comisión (reciben el 100% de la venta de sus platos).
   - **Domicilios:** 1 parada ($3.000 -> $2.000 domiciliario / $1.000 Fonsi), 2 paradas ($5.000 -> $3.500 / $1.500), 3 paradas ($8.000 -> $6.000 / $2.000).
   - **Mototaxi Urbano ($3.000):** 100% para el conductor; paga únicamente $2.000 COP/día activo de suscripción.
   - **Intermunicipal enrutado:** $4.000 COP de comisión por pasajero para Fonsi.

---

## 🚀 Instalación y Despliegue

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar variables de entorno
cp .env.example .env

# 3. Iniciar el bot
npm start
```

Para vincular el número de WhatsApp:
- Escanea el código QR impreso en la terminal, o
- Abre en tu navegador: `http://<IP_DEL_VPS>:3005/qr`
