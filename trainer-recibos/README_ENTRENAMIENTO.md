# Módulo de Entrenamiento de Recibos y Comprobantes — Fonsi (En un 2x3)

Este módulo te permite entrenar a Fonsi para que aprenda a reconocer los comprobantes reales de **Nequi, Daviplata, Bancolombia y Llave Bre-B (`@3506811888`)** que recibas en Fonseca.

---

## 🚀 ¿Cómo usarlo paso a paso?

### 1. Coloca los recibos reales
Copia y pega las capturas de pantalla o fotos de recibos bancarios dentro de la carpeta:
📁 `recibos_para_entrenar/`

### 2. Ejecuta el entrenador
Haz doble clic sobre el archivo:
▶️ `1_ENTRENAR_NUEVOS_RECIBOS.bat`

El programa:
* Analizará cada imagen con la Inteligencia Artificial Visual.
* Te mostrará en pantalla lo que leyó: **Monto, Referencia, Billetera, Destino y Fecha**.
* Si todo está correcto, solo presionas **ENTER**.
* Si algún número quedó mal o borroso, puedes corregirlo en 2 segundos.
* **Se sincroniza automáticamente con la VPS:** Al terminar, envía los patrones aprendidos directamente a Fonsi en el servidor.

### 3. Prueba real en Telegram
Una vez entrenado:
1. Abre el chat de Telegram de [@Fonsi2x3_bot](https://t.me/Fonsi2x3_bot).
2. Pide un domicilio o carrera y escoge **Pagar con Bre-B (Transferencia)**.
3. Envía la captura del comprobante al chat.
4. Fonsi leerá la imagen, validará el monto y el filtro antifraude, y te confirmará la orden al instante sin intervención humana.

---

## 📁 Archivos del Módulo:
* `1_ENTRENAR_NUEVOS_RECIBOS.bat`: Entrena todos los recibos nuevos de la carpeta.
* `2_PROBAR_UN_RECIBO.bat`: Te permite arrastrar una imagen y ver qué lee la IA en pantalla.
* `3_VER_RECIBOS_APRENDIDOS.bat`: Abre el archivo JSON con todos los ejemplos aprendidos.
* `recibos_procesados/`: Carpeta donde se archivan los recibos que ya fueron entrenados.
