import os
import sys
import json
import base64
import urllib.request

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(SCRIPT_DIR, "config.json")
DATASET_FILE = os.path.join(SCRIPT_DIR, "dataset_recibos_aprendidos.json")

def load_config():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {}

def test_image(image_path):
    config = load_config()
    ext = os.path.splitext(image_path)[1].lower()
    mime = "image/png" if ext == ".png" else "image/jpeg"
    if ext == ".webp": mime = "image/webp"

    with open(image_path, "rb") as f:
        b64_data = base64.b64encode(f.read()).decode("utf-8")

    prompt = """Analiza este comprobante bancario de Colombia (Nequi, Daviplata, Bancolombia o Bre-B).
Extrae con precisión:
- amount: número entero sin símbolos.
- reference: número de comprobante o referencia.
- wallet: nequi | daviplata | bancolombia | breb | dale.
- destination: teléfono o cuenta destino.
- date: fecha y hora.

Responde ÚNICAMENTE en JSON puro sin bloques markdown:
{
  "amount": <numero_entero>,
  "reference": "<referencia>",
  "wallet": "<billetera>",
  "destination": "<destino>",
  "date": "<fecha>"
}"""

    payload = {
        "model": config.get("model", "gemini-2.5-flash"),
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64_data}"}}
                ]
            }
        ],
        "temperature": 0.0
    }

    req = urllib.request.Request(
        config["endpoint"],
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {config['api_key']}",
            "Content-Type": "application/json"
        }
    )

    with urllib.request.urlopen(req) as response:
        res_data = json.loads(response.read().decode("utf-8"))
        raw_text = res_data["choices"][0]["message"]["content"]
        clean = raw_text.replace("```json", "").replace("```", "").strip()
        return json.loads(clean)

def main():
    print("=" * 70)
    print("🧪 PROBADOR DE COMPROBANTES DE PAGO (FONSI)")
    print("=" * 70)

    if len(sys.argv) > 1:
        img_path = sys.argv[1].strip('"')
    else:
        img_path = input("Arrastra o escribe la ruta de la imagen del recibo a probar: ").strip().strip('"')

    if not os.path.exists(img_path):
        print(f"❌ El archivo no existe: {img_path}")
        input("\nPresiona ENTER para salir...")
        return

    print(f"\nAnalizando recibo con IA: {os.path.basename(img_path)}...")
    try:
        data = test_image(img_path)
        print("\n" + "=" * 50)
        print("📋 RESULTADO DE EXTRACCIÓN DE FONSI:")
        print("=" * 50)
        print(f"• Monto Transferido:  ${data.get('amount', 0):,} COP".replace(",", "."))
        print(f"• No. de Referencia:  {data.get('reference', 'N/A')}")
        print(f"• Billetera / Banco:  {data.get('wallet', 'desconocido').upper()}")
        print(f"• Destino (@3506811888): {data.get('destination', 'N/A')}")
        print(f"• Fecha Registrada:   {data.get('date', 'N/A')}")
        print("=" * 50)

        # Validación antifraude simulada
        dest = str(data.get('destination', ''))
        es_cuenta_fonsi = '3506811888' in dest or '@3506811888' in dest
        print("\n🛡️ AUDITORÍA DE SEGURIDAD:")
        print(f"  - Cuenta Destino Oficial: {'✅ Válida (@3506811888)' if es_cuenta_fonsi else '⚠️ No coincide exactamente con 3506811888'}")
        print(f"  - Referencia Válida:     {'✅ Sí (' + data.get('reference', '') + ')' if data.get('reference') != 'NO_DETECTADA' else '❌ No legible'}")

    except Exception as e:
        print(f"❌ Error al analizar la imagen: {e}")

    input("\nPresiona ENTER para finalizar...")

if __name__ == "__main__":
    main()
