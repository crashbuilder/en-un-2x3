# 🛵 En un 2x3 — Chatbot Fonsi & Plataforma Web Unificada

> **¿Qué deseas? Te lo llevo en un 2x3**  
> Sistema integral y autónomo de domicilios, mensajería, mototaxis, viajes intermunicipales y comercio local para **Fonseca, La Guajira**, impulsado por Inteligencia Artificial (**Google Gemini 2.5 Flash**).

---

## 🌐 Plataforma Web Unificada (`:3000`)

Toda la operativa y control administrativo se concentra en un **único enlace interactivo y responsivo** (PC y móvil):

- 🛰️ **Radar GPS en Vivo:** Mapa interactivo con la ubicación en tiempo real de mototaxis y servicios activos.
- 📦 **Gestión de Pedidos:** Control de estados (*pendiente, confirmado, en camino, entregado*), tarifas y comprobantes.
- 📊 **Analítica BI (Chart.js):** Gráficos interactivos de ingresos diarios, tipos de servicio y métodos de pago.
- 🛵 **Flota de Conductores:** Directorio de mototaxis y automóviles con vehículos, colores, placas y teléfonos.
- 🏪 **Comercios Aliados:** Gestión de restaurantes, tiendas y planes de pauta publicitaria.
- 📒 **Libro Mayor:** Contabilidad automática en partida doble (*Debe / Haber*).
- 💰 **Liquidaciones:** Cierre diario de caja y comisiones de repartidores.
- 🗺️ **Rastreo para Clientes:** Enlace directo de seguimiento para cada pedido (`/track/FX-XXXX`).

---

## 🚀 Stack Tecnológico

- **Bot & Backend:** Node.js 20+ con TypeScript y Telegraf / OpenClaw.
- **IA Multimodal:** Google Gemini 2.5 Flash con OCR para lectura visual de comprobantes de pago.
- **Pagos Digitales:** Llave Universal **Bre-B** (`@3506811888`) con generación de Código QR dinámico.
- **Base de Datos:** PostgreSQL 16 relacional con esquema contable de partida doble.
- **Caché y Sesiones:** Redis 7 Alpine.
- **Despliegue:** Docker Compose con persistencia de datos en VPS Ubuntu 24.04 LTS.

---

## 💳 Flujo de Pagos & Seguridad

1. **Efectivo:** Pago contra entrega con registro automático en el módulo de liquidaciones.
2. **Transferencia Digital Bre-B:**
   - Envío automático de la **Llave Universal Bre-B:** `<code>@3506811888</code>` *(Tipo Alias con @)*.
   - Envío de imagen con el **Código QR de Pago Bre-B**.
   - **Gemini Vision OCR:** Lectura del comprobante en 2 segundos (Monto, Referencia, Billetera y Fecha).
   - **Antifraude:** Detección de comprobantes reciclados/duplicados y cotejo de valor.

---

## 🚗 Viajes en Carro y Cupos Intermunicipales

Para servicios de automóvil o rutas intermunicipales (Distracción, Barrancas, San Juan del Cesar, Villanueva, Maicao, Riohacha), el sistema asigna y entrega la ficha completa del chofer:
- 👤 Nombre del Conductor
- 📞 Teléfono / WhatsApp con enlace directo (`wa.me`)
- 🚗 Modelo del Vehículo
- 🎨 Color del Carro
- 🏷️ Placa

---

## 🛠️ Instalación y Despliegue

```bash
# 1. Clonar el repositorio
git clone https://github.com/crashbuilder/en-un-2x3.git
cd en-un-2x3

# 2. Configurar variables de entorno
cp .env.example .env

# 3. Levantar stack con Docker
docker compose up -d --build
```

---

## 📄 Créditos
Desarrollado para **En un 2x3** — Fonseca, La Guajira, Colombia.
