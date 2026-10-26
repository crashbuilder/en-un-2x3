import * as fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config();

async function testFoodResponse() {
  const soul = fs.readFileSync('/workspace/SOUL.md', 'utf8');
  const userMsg = "Quiero comer algo";

  const promptAntiRobot = `
REGLAS SUPREMAS DE ATENCIÓN Y PRECISIÓN:
1. ATENCIÓN INMEDIATA A ANTOJOS Y COMIDA (OBLIGATORIO): Si el cliente dice algo general como "quiero comer algo", "tengo hambre", "¿qué hay de comer?":
   - Saluda con la promesa oficial: "¡Qué hubo! 🛵 ¿Qué deseas? Te lo llevo en un 2x3."
   - Menciona de forma atractiva 2 o 3 opciones típicas de los aliados en Fonseca para que se antoje:
     • Comida casera y típica en Donde Isne o Maye (chivo en coco, carne asada, gallina guisada).
     • Bandeja paisa y sopas tradicionales en La Jefa.
     • Comidas rápidas y fritos en Sr. Loquillo's (chicharrón BBQ, pollo apanado, asados).
     • Fresas con crema y postres en La Fressería.
   - Pregúntale de forma directa qué se le antoja hoy o de cuál negocio prefiere pedir. CERO botones forzados, pura conversación amable, viva y con acento guajiro respetuoso.
2. SÉ CONCISO Y DIRECTO: Respuestas de 2 a 4 líneas. Prohibido usar "De Una".
`;

  const reqBody = {
    model: 'gemini-2.5-flash',
    messages: [
      { role: 'system', content: soul + '\n\n' + promptAntiRobot },
      { role: 'user', content: userMsg }
    ],
    temperature: 0.3
  };

  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.LLM_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(reqBody)
  });

  const json = await res.json();
  console.log("=== RESPUESTA DE FONSI A 'QUIERO COMER ALGO' ===");
  console.log(json.choices[0].message.content);
  console.log("================================================");
}

testFoodResponse().catch(console.error);
