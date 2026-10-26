import * as fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config();

async function testPromptResponse() {
  const soul = fs.readFileSync('/workspace/SOUL.md', 'utf8');
  const userMsg = "Me da por favor una gaseosa de litro, una caja de cigarros y una sobrebarriga guisada";
  
  const reqBody = {
    model: 'gemini-2.5-flash',
    messages: [
      { role: 'system', content: soul },
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
  console.log("=== RESPUESTA DE FONSI ===");
  console.log(json.choices[0].message.content);
  console.log("==========================");
}

testPromptResponse().catch(console.error);
