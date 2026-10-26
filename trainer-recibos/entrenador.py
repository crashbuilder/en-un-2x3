import os
import sys
import json
import base64
import urllib.request
import urllib.error
import shutil
import subprocess

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
INCOMING_DIR = os.path.join(SCRIPT_DIR, "recibos_para_entrenar")
PROCESSED_DIR = os.path.join(SCRIPT_DIR, "recibos_procesados")
DATASET_FILE = os.path.join(SCRIPT_DIR, "dataset_recibos_aprendidos.json")
CONFIG_FILE = os.path.join(SCRIPT_DIR, "config.json")

os.makedirs(INCOMING_DIR, exist_ok=True)
os.makedirs(PROCESSED_DIR, exist_ok=True)

def load_config():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {
        "api_key": "",
        "model": "gemini-2.5-flash",
        "endpoint": "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        "vps_host": "contabo",
        "vps_target_path": "/root/en-un-2x3/workspace-fonsi/dataset_recibos.json"
    }

def load_dataset():
    if os.path.exists(DATASET_FILE):
        with open(DATASET_FILE, 'r', encoding='utf-8') as f:
            try:
                return json.load(f)
            except Exception:
                return []
    return []

def save_dataset(data):
    with open(DATASET_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def analyze_receipt_with_vision(image_path, config):
    ext = os.path.splitext(image_path)[1].lower()
    mime = "image/png" if ext == ".png" else "image/jpeg"
    if ext == ".webp": mime = "image/webp"

    with open(image_path, "rb") as f:
        b64_data = base64.b64encode(f.read()).decode("utf-8")

    prompt = """Analiza este comprobante bancario real de Colombia (Nequi, Daviplata, Bancolombia, Bre-B, Dale, etc.).
Extrae exactamente los siguientes campos con la máxima precisión posible:
- amount: número entero sin puntos, sin comas y sin el signo $ (ej. si dice $15.000 pon 15000).
- reference: número de comprobante, aprobación o transacción (ej. M1234567, 1029384).
- wallet: la entidad bancaria o billetera (nequi, daviplata, bancolombia, breb, dale).
- destination: número de celular o cuenta destino (ej. 3506811888).
- date: fecha y hora de la transacción (YYYY-MM-DD o formato legible).

Responde ÚNICAMENTE en JSON puro sin bloques markdown:
{
  "amount": <numero_entero>,
  "reference": "<referencia_exacta>",
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

def sync_to_vps(config):
    vps_host = config.get("vps_host", "contabo")
    vps_path = config.get("vps_target_path", "/root/en-un-2x3/workspace-fonsi/dataset_recibos.json")
    print(f"\n📡 Sincronizando dataset aprendido con Fonsi en la VPS ({vps_host})...")
    cmd = ["scp", DATASET_FILE, f"{vps_host}:{vps_path}"]
    try:
        ret = subprocess.run(cmd, capture_output=True, text=True)
        if ret.returncode == 0:
            print("✅ ¡Sincronización exitosa! Fonsi ya tiene disponible este conocimiento en tiempo real.")
        else:
            print(f"⚠️ Nota de sincronización SCP: {ret.stderr.strip()}")
    except Exception as e:
        print(f"⚠️ No se pudo ejecutar scp automáticamente: {e}")

def main():
    print("=" * 70)
    print("🎓 ENTRENADOR Y AUDITOR VISUAL DE RECIBOS — FONSI (EN UN 2X3)")
    print("=" * 70)

    config = load_config()
    dataset = load_dataset()
    print(f"📚 Ejemplos aprendidos previamente en el dataset: {len(dataset)}")

    files = [f for f in os.listdir(INCOMING_DIR) if f.lower().endswith(('.jpg', '.jpeg', '.png', '.webp'))]
    if not files:
        print(f"\n📁 La carpeta está vacía:")
        print(f"   {INCOMING_DIR}")
        print("\n👉 Para entrenar: Pega aquí las capturas o fotos reales de recibos de Nequi / Bre-B y vuelve a ejecutar este programa.")
        input("\nPresiona ENTER para salir...")
        return

    print(f"\nSe encontraron {len(files)} recibo(s) nuevo(s) para entrenar:\n")

    trained_count = 0
    for idx, fname in enumerate(files, 1):
        fpath = os.path.join(INCOMING_DIR, fname)
        print("-" * 70)
        print(f"[{idx}/{len(files)}] Analizando comprobante: {fname}...")
        try:
            parsed = analyze_receipt_with_vision(fpath, config)
            monto = parsed.get("amount", 0)
            ref = parsed.get("reference", "NO_DETECTADA")
            billetera = parsed.get("wallet", "nequi")
            destino = parsed.get("destination", "3506811888")
            fecha = parsed.get("date", "")

            print("\n  🔍 LECTURA AUTOMÁTICA DE LA IA:")
            print(f"     • 💰 Monto Transferido: ${monto:,} COP".replace(",", "."))
            print(f"     • 🔢 No. de Referencia: {ref}")
            print(f"     • 📱 Billetera:        {billetera.upper()}")
            print(f"     • 👤 Destino / Llave:   {destino}")
            print(f"     • 📅 Fecha / Hora:      {fecha}")

            ans = input("\n¿Los datos leídos son 100% correctos? [ENTER = Sí / escribe 'no' para corregir]: ").strip().lower()

            if ans in ['no', 'n']:
                print("\n✏️ Corrección de campos (presiona ENTER para mantener el valor leído):")
                monto_in = input(f"  Monto [{monto}]: ").strip()
                if monto_in: monto = int(monto_in.replace(".", "").replace("$", "").replace(" ", ""))

                ref_in = input(f"  Referencia [{ref}]: ").strip()
                if ref_in: ref = ref_in

                bill_in = input(f"  Billetera [{billetera}]: ").strip()
                if bill_in: billetera = bill_in

                dest_in = input(f"  Destino [{destino}]: ").strip()
                if dest_in: destino = dest_in

                fecha_in = input(f"  Fecha [{fecha}]: ").strip()
                if fecha_in: fecha = fecha_in

            # Agregar al dataset
            learned_example = {
                "archivo_origen": fname,
                "monto": monto,
                "referencia": ref,
                "billetera": billetera,
                "destino": destino,
                "fecha": fecha
            }
            dataset.append(learned_example)
            save_dataset(dataset)

            # Mover a procesados
            dest_fpath = os.path.join(PROCESSED_DIR, fname)
            shutil.move(fpath, dest_fpath)
            trained_count += 1
            print(f"  ✅ Recibo verificado y guardado en el dataset de aprendizaje.")

        except Exception as e:
            print(f"  ❌ Error al procesar {fname}: {e}")

    if trained_count > 0:
        sync_to_vps(config)
        print(f"\n🎉 ¡Se entrenaron {trained_count} recibo(s) con éxito!")
        print(f"Total en memoria de Fonsi: {len(dataset)} ejemplos.")
    else:
        print("\nNo se completó ningún recibo nuevo.")

    input("\nPresiona ENTER para finalizar...")

if __name__ == "__main__":
    main()
