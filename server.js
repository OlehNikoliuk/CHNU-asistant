import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import Database from 'better-sqlite3';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// ШАР 1: OBSERVABILITY / TRACES (SQLite)
// ==========================================
const db = new Database(path.join(__dirname, 'assistant_logs.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS traces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    query TEXT,
    entities TEXT,
    layer_hit TEXT,
    latency_ms INTEGER,
    status TEXT,
    reply TEXT
  )
`);

const insertTraceStmt = db.prepare(`
  INSERT INTO traces (query, entities, layer_hit, latency_ms, status, reply)
  VALUES (?, ?, ?, ?, ?, ?)
`);

function recordTrace({ query, entities = null, layerHit, startTime, status, reply }) {
  const latency = Date.now() - startTime;
  insertTraceStmt.run(
    query,
    entities ? JSON.stringify(entities) : null,
    layerHit,
    latency,
    status,
    reply ? reply.substring(0, 500) : ''
  );
  console.log(`[TRACE] [${layerHit}] [${latency}ms] Status: ${status}`);
}

// ==========================================
// ШАР 2: GUARDRAILS (Захист і фільтрація)
// ==========================================
const FORBIDDEN_PATTERNS = [
  /ignore previous instructions/i,
  /забудь (всі |попередні )?інструкції/i,
  /system prompt/i,
  /ти тепер (не|новий)/i,
  /jailbreak/i,
  /drop table/i,
  /<script>/i
];

const TOXIC_PATTERNS = [
  /\b(хуй|пізд|єбат|бляд|сука|мудак|гандон|чмо)\b/i
];

function runGuardrails(query) {
  if (!query || typeof query !== 'string') {
    return { passed: false, reason: 'EMPTY_INPUT', message: 'Будь ласка, введіть текстове повідомлення.' };
  }

  if (query.length > 500) {
    return { passed: false, reason: 'TOO_LONG', message: 'Запит занадто довгий. Будь ласка, сформулюйте запитання коротше.' };
  }

  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(query)) {
      return { 
        passed: false, 
        reason: 'PROMPT_INJECTION', 
        message: 'Запит заблоковано системою безпеки інфо-кіоску ННІФТКН.' 
      };
    }
  }

  for (const pattern of TOXIC_PATTERNS) {
    if (pattern.test(query)) {
      return { 
        passed: false, 
        reason: 'TOXICITY', 
        message: 'Будь ласка, дотримуйтесь академічної доброчесності та культури мовлення.' 
      };
    }
  }

  return { passed: true };
}

// ==========================================
// ШАР 3: КЛІЄНТ LLM ТА БАЗА ЗНАНЬ
// ==========================================
const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const openai = new OpenAI({
  baseURL: OLLAMA_BASE.endsWith('/v1') ? OLLAMA_BASE : `${OLLAMA_BASE}/v1`,
  apiKey: "ollama",
});

let scheduleData = [];
let knowledgeBase = {};

try {
  let schedulePath = path.join(__dirname, 'schedule_2026.json');
  if (!fs.existsSync(schedulePath)) {
    schedulePath = path.join(__dirname, 'schedule 2026.json');
  }
  const kbPath = path.join(__dirname, 'knowledge_base.json');

  if (fs.existsSync(schedulePath)) {
    scheduleData = JSON.parse(fs.readFileSync(schedulePath, 'utf-8'));
  }
  if (fs.existsSync(kbPath)) {
    knowledgeBase = JSON.parse(fs.readFileSync(kbPath, 'utf-8'));
  }
  console.log(`[Ініціалізація] Записів розкладу: ${scheduleData.length}`);
} catch (err) {
  console.error("[Помилка] Збій читання JSON-файлів:", err.message);
}

const CALL_SCHEDULE = `⏰ Розклад дзвінків ННІФТКН:
• 1 пара: 08:20 – 09:40
• 2 пара: 09:50 – 11:10
• 3 пара: 11:30 – 12:50
• 4 пара: 13:00 – 14:20
• 5 пара: 14:40 – 16:00
• 6 пара: 16:10 – 17:30`;

const DAYS_MAP = ["неділя", "понеділок", "вівторок", "середа", "четвер", "п'ятниця", "субота"];
const normalize = (str) => (str || "").toLowerCase().replace(/['’`ʼ]/g, "").trim();

// ==========================================
// ШАР 4: ROUTER & FAST-CACHE (Без виклику LLM)
// ==========================================
function checkDirectKnowledge(query) {
  const q = normalize(query);

  if (q.includes("дзвін") || q.includes("пари коли") || q.includes("початок пар") || q.includes("сітка")) {
    return CALL_SCHEDULE;
  }

  if (q.includes("деканат") || q.includes("декан") || q.includes("заступник")) {
    const deanery = knowledgeBase.deanery || knowledgeBase.contacts?.deanery || knowledgeBase["деканат"];
    if (deanery) {
      if (typeof deanery === 'string') return `🏛️ Інформація про деканат:\n${deanery}`;
      return `🏛️ Деканат ННІФТКН:\n• Адреса: ${deanery.address || "вул. Сторожинецька, 101, Корпус №9"}\n• Кабінет: ${deanery.room || deanery.office || "2-й поверх"}\n• Години роботи: ${deanery.working_hours || "08:30 – 17:00"}\n• Пошта: ${deanery.email || "iftcs@chnu.edu.ua"}`;
    }
    return `🏛️ Деканат ННІФТКН розташований у Корпусі №9 (вул. Сторожинецька, 101, 2-й поверх). Графік роботи: пн-пт з 08:30 до 17:00.`;
  }

  if (q.includes("корпус") || q.includes("адрес") || q.includes("де знаходиться інститут") || q.includes("де вхід") || q.includes("сторожинецька")) {
    if (knowledgeBase.commonInfo?.buildings) {
      const buildingsList = knowledgeBase.commonInfo.buildings.map(b => `• ${b.name}: ${b.address}`).join("\n");
      return `📍 Корпуси та адреси:\n${buildingsList}`;
    }
    return `📍 ННІФТКН ЧНУ ім. Юрія Федьковича:\n• Основна адреса: м. Чернівці, вул. Сторожинецька, 101 (Корпус №9)`;
  }

  return null;
}

// ==========================================
// ШАР 5: MCP-LIKE ENTITY PARSER & RAG (qwen2.5:7b)
// ==========================================
async function extractEntitiesWithLLM(userQuery) {
  const q = normalize(userQuery);
  const now = new Date();

  let day = null;
  if (q.includes("сьогодні")) day = DAYS_MAP[now.getDay()];
  else if (q.includes("завтра")) day = DAYS_MAP[(now.getDay() + 1) % 7];
  else if (q.includes("післязавтра")) day = DAYS_MAP[(now.getDay() + 2) % 7];
  else {
    for (const d of DAYS_MAP) {
      if (q.includes(d.slice(0, 4))) { 
        day = d; 
        break; 
      }
    }
  }

  const groupMatch = q.match(/\b\d{2,3}[а-яa-z]?\b/);
  const group = groupMatch ? groupMatch[0] : null;

  let teacher = null;
  if (q.includes("ряб")) teacher = "Рябий";
  else if (q.includes("ластівк")) teacher = "Ластівка";
  else if (q.includes("фельд")) teacher = "Фельдман";
  else if (q.includes("феськ")) teacher = "Фесько";

  if (teacher || group || day) {
    return { teacher, group, day };
  }

  const prompt = `Ти — точний парсер розкладу. Поверни виключно JSON об'єкт: {"teacher": null, "group": null, "day": null}. Текст студента: "${userQuery}"`;
  
  try {
    const fetchPromise = openai.chat.completions.create({
      model: "qwen2.5:7b",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.0,
      max_tokens: 60
    });

    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error("Timeout LLM")), 3000)
    );

    const res = await Promise.race([fetchPromise, timeoutPromise]);
    let raw = res.choices[0]?.message?.content || "{}";
    raw = raw.replace(/```json/gi, '').replace(/```/gi, '').trim();
    return JSON.parse(raw);
  } catch (err) {
    return { teacher: null, group: null, day: null };
  }
}

async function searchSchedule(query) {
  if (!Array.isArray(scheduleData) || scheduleData.length === 0) return { results: [], entities: null };

  const entities = await extractEntitiesWithLLM(query);
  const targetTeacher = entities.teacher ? normalize(entities.teacher) : null;
  const targetGroup = entities.group ? normalize(entities.group) : null;
  const targetDay = entities.day ? normalize(entities.day) : null;

  if (!targetTeacher && !targetGroup && !targetDay) {
    return { results: [], entities };
  }

  let results = scheduleData.filter(item => {
    const itemTeacher = normalize(item.teacher);
    const itemGroup = normalize(item.group);
    const itemDay = normalize(item.day);

    if (targetTeacher && !itemTeacher.includes(targetTeacher)) return false;
    if (targetGroup && !itemGroup.includes(targetGroup)) return false;
    if (targetDay && !itemDay.includes(targetDay.slice(0, 4))) return false;

    return true;
  });

  if (results.length === 0 && targetTeacher) {
    results = scheduleData.filter(item => normalize(item.teacher).includes(targetTeacher));
  }

  if (results.length === 0 && targetGroup) {
    results = scheduleData.filter(item => normalize(item.group).includes(targetGroup));
  }

  return { results: results.slice(0, 20), entities };
}

// ==========================================
// VISION ОБРОБКА ЧЕРЕЗ MOONDREAM
// ==========================================
async function processImageRequest(imageBase64, userPrompt) {
  const promptText = userPrompt || "Прочитай розклад або оголошення на цьому фото та структуруй інформацію.";
  const cleanBase64 = imageBase64.replace(/^data:image\/[a-z]+;base64,/, '');

  console.log(`[VISION] Запит до moondream (довжина base64: ${cleanBase64.length})...`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 40000);

  try {
    const nativeOllamaUrl = OLLAMA_BASE.replace(/\/v1\/?$/, '');
    const response = await fetch(`${nativeOllamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: "moondream",
        prompt: promptText,
        images: [cleanBase64],
        stream: false
      })
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text();
      console.error("[VISION Error]:", response.status, errText);
      return "⚠️ Модель зору moondream повернула помилку. Перевірте статус Ollama.";
    }

    const data = await response.json();
    return data.response ? data.response.trim() : "Не вдалося розпізнати текст на фото.";
  } catch (err) {
    clearTimeout(timeoutId);
    console.error("[VISION Exception]:", err.message);
    if (err.name === 'AbortError') {
      return "⏱️ Час очікування розпізнавання фото минув. Спробуйте зображення меншого розміру.";
    }
    return `📸 Помилка обробки фото: ${err.message}`;
  }
}

// ==========================================
// ШАР 6: ГОЛОВНИЙ DISPATCHER
// ==========================================
async function handleAssistantRequest(req, res) {
  const startTime = Date.now();
  const message = req.body.query || req.body.message || "";
  const imageBase64 = req.body.image || null;
  const history = Array.isArray(req.body.history) ? req.body.history : [];

  // 1. Guardrails
  if (!imageBase64) {
    const guard = runGuardrails(message);
    if (!guard.passed) {
      recordTrace({
        query: message,
        layerHit: 'GUARDRAILS_REJECT',
        startTime,
        status: guard.reason,
        reply: guard.message
      });
      return res.json({ reply: guard.message });
    }
  }

  // 2. Vision Request
  if (imageBase64) {
    const visionReply = await processImageRequest(imageBase64, message);
    recordTrace({
      query: message || '[IMAGE_PROMPT]',
      layerHit: 'MOONDREAM_VISION',
      startTime,
      status: 'SUCCESS',
      reply: visionReply
    });
    return res.json({ reply: visionReply });
  }

  // 3. Fast-Cache / Router
  const direct = checkDirectKnowledge(message);
  if (direct) {
    recordTrace({
      query: message,
      layerHit: 'FAST_CACHE',
      startTime,
      status: 'SUCCESS',
      reply: direct
    });
    return res.json({ reply: direct });
  }

  // 4. RAG Search & LLM Synthesis (qwen2.5:7b)
  const { results: matchedClasses, entities } = await searchSchedule(message);
  const hasExplicitIntent = entities && (entities.teacher || entities.group || entities.day);

  if (matchedClasses.length > 0 && hasExplicitIntent) {
    const scheduleContext = matchedClasses.map(c => 
      `- ${c.day}, ${c.period} пара: ${c.subject} (${c.type}), викладач: ${c.teacher}, ауд: ${c.room}, група: ${c.group}`
    ).join("\n");

    const answerPrompt = `Ти — офіційний цифровий навігатор інституту ННІФТКН ЧНУ ім. Юрія Федьковича.
Дай структуровану, чітку відповідь студенту українською мовою на основі даних розкладу.

ПРАВИЛА:
1. НЕ пиши вступних фраз на зразок "Ось відповідь:", "За вашим запитом:".
2. Не вигадуй жодних даних від себе, спирайся виключно на наданий контекст.
3. Подавай розклад чіткими блоками: день, номер пари, назва дисципліни, викладач, аудиторія.

Запитання: "${message}"

Знайдені записи в базі розкладу:
${scheduleContext}`;

    try {
      const resAi = await openai.chat.completions.create({
        model: "qwen2.5:7b",
        messages: [{ role: "user", content: answerPrompt }],
        temperature: 0.1,
        max_tokens: 700
      });

      let reply = resAi.choices[0]?.message?.content || "";
      reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

      if (reply) {
        recordTrace({
          query: message,
          entities,
          layerHit: 'RAG_LLM_SYNTHESIS',
          startTime,
          status: 'SUCCESS',
          reply
        });
        return res.json({ reply });
      }
    } catch (err) {
      console.warn("[RAG Generation Fallback]:", err.message);
    }

    const fallbackList = matchedClasses.map(c => 
      `• ${c.day} | ${c.period} пара: ${c.subject}\n   ${c.teacher} | ${c.room} | гр. ${c.group}`
    ).join("\n\n");
    const fallbackReply = `Ось розклад за вашим запитом:\n\n${fallbackList}`;

    recordTrace({
      query: message,
      entities,
      layerHit: 'RAG_FALLBACK_DETERMINISTIC',
      startTime,
      status: 'FALLBACK',
      reply: fallbackReply
    });
    return res.json({ reply: fallbackReply });
  }

  if (hasExplicitIntent && matchedClasses.length === 0) {
    const notFoundReply = "За цим запитом пар не знайдено. Перевірте правильність написання прізвища викладача або номера групи.";
    recordTrace({
      query: message,
      entities,
      layerHit: 'RAG_NOT_FOUND',
      startTime,
      status: 'EMPTY_RESULT',
      reply: notFoundReply
    });
    return res.json({ reply: notFoundReply });
  }

  // 5. Загальне спілкування (qwen2.5:7b)
  const systemPrompt = `Ти — ввічливий цифровий помічник студентів інституту ННІФТКН ЧНУ ім. Юрія Федьковича. 
Відповідай стисло, доброзичливо та виключно українською мовою. Допомагай зорієнтуватися по розкладу пар, викладачах, корпусах та деканату.
Довідка: ${JSON.stringify(knowledgeBase)}`;

  try {
    const completion = await openai.chat.completions.create({
      model: "qwen2.5:7b",
      messages: [
        { role: "system", content: systemPrompt },
        ...history.slice(-4),
        { role: "user", content: message }
      ],
      temperature: 0.3,
      max_tokens: 350
    });

    let botReply = completion.choices[0]?.message?.content || "";
    botReply = botReply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    recordTrace({
      query: message,
      entities,
      layerHit: 'GENERAL_CHAT_LLM',
      startTime,
      status: 'SUCCESS',
      reply: botReply
    });

    return res.json({ reply: botReply });
  } catch (error) {
    const errReply = "🏛️ Деканат ННІФТКН: вул. Сторожинецька, 101 (Корпус №9, 2 поверх). Години роботи: 08:30 – 17:00.";
    recordTrace({
      query: message,
      layerHit: 'ERROR_CATCH',
      startTime,
      status: 'SERVER_ERROR',
      reply: errReply
    });
    return res.json({ reply: errReply });
  }
}

// ==========================================
// API АНАЛІТИКИ ТА ЕНДПОІНТИ
// ==========================================
app.get('/api/analytics', (req, res) => {
  const rows = db.prepare('SELECT * FROM traces ORDER BY timestamp DESC LIMIT 50').all();
  res.json(rows);
});

app.post('/api/assistant', handleAssistantRequest);
app.post('/assistant', handleAssistantRequest);
app.post('/api/chat', handleAssistantRequest);
app.post('/chat', handleAssistantRequest);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущено на http://localhost:${PORT} (Модель: qwen2.5:7b, Vision: moondream)`);
});