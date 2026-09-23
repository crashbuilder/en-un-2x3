import { Client } from 'pg';
import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

async function runTest() {
  console.log("Iniciando prueba con Restaurante La Jefa...");

  // 1. Simular la herramienta (Buscar en Base de Datos)
  const dbClient = new Client({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'fonsi_user',
    password: process.env.DB_PASSWORD || 'fonsi_password',
    database: process.env.DB_NAME || 'en_un_2x3',
  });
  
  await dbClient.connect();
  const res = await dbClient.query("SELECT name, menu, specialty FROM merchants WHERE name ILIKE '%La Jefa%'");
  await dbClient.end();

  const laJefaData = res.rows[0];

  // 2. Cargar el Alma de Fonsi
  const fonsiSoul = fs.readFileSync('/workspace/SOUL.md', 'utf8');

  // 3. Conectar al LLM (Gemini)
  const openai = new OpenAI({ 
    apiKey: process.env.LLM_API_KEY,
    baseURL: process.env.LLM_BASE_URL,
    dangerouslyAllowBrowser: true 
  });

  // 4. Simular la conversación inyectando la información de la BD
  const systemPrompt = `${fonsiSoul}\n\nINFORMACIÓN DE BASE DE DATOS OBTENIDA:\nRestaurante: ${laJefaData.name}\nEspecialidad: ${laJefaData.specialty}\nMenú: ${JSON.stringify(laJefaData.menu)}`;

  const response = await openai.chat.completions.create({
    model: process.env.LLM_MODEL || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Hola Fonsi, ¿qué me ofreces hoy de Restaurante La Jefa?' }
    ],
    temperature: 0.7,
  });

  console.log("\n--- RESPUESTA DE FONSI (GEMINI) ---\n");
  console.log(response.choices[0]?.message?.content);
  console.log("\n-----------------------------------\n");
}

runTest().catch(console.error);
