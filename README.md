# 🛵 En un 2x3 — Chatbot Fonsi & Plataforma de Control

> **¿Qué deseas? Te lo llevo en un 2x3**  
> Sistema integral y autónomo de domicilios, mensajería, mototaxis y comercio local para **Fonseca, La Guajira**, impulsado por Inteligencia Artificial (**Google Gemini 2.5 Flash**).

---

## 🚀 Arquitectura & Stack Tecnológico

- **Bot & Backend:** Node.js 20+ con TypeScript y OpenClaw / Telegraf.
- **IA Multimodal:** Google Gemini 2.5 Flash con OCR para lectura de comprobantes de pago (Nequi, Daviplata, Bancolombia, Bre-B).
- **Base de Datos:** PostgreSQL 16 relacional con esquema en partida doble contable.
- **Caché y Sesiones:** Redis 7 Alpine.
- **Plataforma de Control Web:** Streamlit (Python 3.11) con métricas en tiempo real, KPIs y visualizador de fases.
- **Despliegue:** Docker Compose con persistencia de volúmenes en VPS Ubuntu 24.04 LTS.

---

## 📌 Resumen de Fases del Proyecto

| Fase | Nombre | Descripción |
| :---: | :--- | :--- |
| **Fase 0** | **Fundamentos e Infraestructura** | Docker stack, PostgreSQL relacional, Redis, Telegraf y personalidad de Fonsi (SOUL.md). |
| **Fase 1** | **Atención & Domicilios** | Catálogo en vivo de restaurantes aliados, carrito inteligente, generación de órdenes FX-####. |
| **Fase 2** | **OCR & Contabilidad** | Verificación visual antifraude de comprobantes, libro mayor en partida doble y liquidación de motos. |
| **Fase 3** | **Mandados & Mototaxis** | Cotizador urbano e intermunicipal (.000 / .000 / .000), cálculo de ETAs y relay anónimo. |
| **Fase 4** | **Publicidad & Estados** | Planes de pauta (, , ), contratos de comercios aliados y publicación de estados. |
| **Fase 5** | **Panel Web & Despliegue** | Plataforma interactiva en Streamlit (puerto 8507) y despliegue 24/7 en VPS. |

---

## 🛠️ Instalación y Puesta en Marcha Local

1. **Clonar el repositorio:**
   `ash
   git clone https://github.com/crashbuilder/en-un-2x3.git
   cd en-un-2x3
   `

2. **Configurar variables de entorno:**
   `ash
   cp .env.example .env
   # Edita .env con tus claves de Gemini y Telegram
   `

3. **Levantar el stack completo con Docker:**
   `ash
   docker compose up -d --build
   `

4. **Acceder a los servicios:**
   - **Bot Telegram:** [@Fonsi2x3_bot](https://t.me/Fonsi2x3_bot)
   - **Panel de Control Streamlit:** http://localhost:8501 (o 8507 según mapeo)
   - **Base de Datos PostgreSQL:** localhost:5432

---

## 📄 Licencia y Créditos
Desarrollado para **En un 2x3** — Fonseca, La Guajira, Colombia.
