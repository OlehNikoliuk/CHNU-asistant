import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Клієнт Ollama
const openai = new OpenAI({
  baseURL: process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1",
  apiKey: "ollama",
});

// Бази даних
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
  console.log(`[Ініціалізація] Базу успішно підключено. Записів розкладу: ${scheduleData.length}`);
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

// 1. Швидка база знань
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
    return `🏛️ Деканат ННІФТКН розташований у Корпусі №9 (вул. Сторожинецька, 101, 2-й поверх). Працює в будні дні з 08:30 до 17:00.`;
  }

  if (q.includes("корпус") || q.includes("адрес") || q.includes("де знаходиться інститут") || q.includes("де вхід") || q.includes("сторожинецька")) {
    if (knowledgeBase.commonInfo?.buildings) {
      const buildingsList = knowledgeBase.commonInfo.buildings.map(b => `• ${b.name}: ${b.address}`).join("\n");
      return `📍 Корпуси та адреси:\n${buildingsList}`;
    }
    return `📍 ННІФТКН ЧНУ ім. Юрія Федьковича:\n• Основна адреса: м. Чернівці, вул. Сторожинецька, 101 (Корпус №9)`;
  }

  if (q.includes("гуртожит") || q.includes("студмістечк") || q.includes("поселення")) {
    if (knowledgeBase.commonInfo?.dormitories) {
      return `🏢 Інформація про гуртожитки:\n${knowledgeBase.commonInfo.dormitories}`;
    }
  }

  return null;
}

// 2. Витягування сутностей
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

  const prompt = `Ти — парсер запитів. Витягни сутності JSON: {"teacher": null, "group": null, "day": null}. Текст: "${userQuery}"`;
  
  try {
    const fetchPromise = openai.chat.completions.create({
      model: "qwen2.5:3b",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.0,
      max_tokens: 80
    });

    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error("Timeout LLM")), 2500)
    );

    const res = await Promise.race([fetchPromise, timeoutPromise]);
    let raw = res.choices[0]?.message?.content || "{}";
    raw = raw.replace(/```json/gi, '').replace(/```/gi, '').trim();
    return JSON.parse(raw);
  } catch (err) {
    return { teacher: null, group: null, day: null };
  }
}

// 3. Семантичний пошук розкладу
async function searchSchedule(query) {
  if (!Array.isArray(scheduleData) || scheduleData.length === 0) return { results: [], entities: null };

  const entities = await extractEntitiesWithLLM(query);
  console.log("[Розпізнані сутності]:", entities);

  const targetTeacher = entities.teacher ? normalize(entities.teacher) : null;
  const targetGroup = entities.group ? normalize(entities.group) : null;
  const targetDay = entities.day ? normalize(entities.day) : null;

  // Якщо немає жодної цілі пошуку (наприклад, просто "Привіт") — нічого не фільтруємо
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
    results = scheduleData.filter(item => {
      const itemTeacher = normalize(item.teacher);
      return itemTeacher.includes(targetTeacher);
    });
  }

  if (results.length === 0 && targetGroup) {
    results = scheduleData.filter(item => {
      const itemGroup = normalize(item.group);
      return itemGroup.includes(targetGroup);
    });
  }

  return { results: results.slice(0, 15), entities };
}

// 4. Обробка фотографій
async function processImageRequest(imageBase64, userPrompt) {
  const promptText = userPrompt || "Прочитай розклад або інформацію на фото і коротко перекажи основні деталі (групи, пари, кабінети).";

  try {
    const response = await openai.chat.completions.create({
      model: "moondream",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: promptText },
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${imageBase64}` }
            }
          ]
        }
      ],
      max_tokens: 300
    });

    return response.choices[0]?.message?.content || "Не вдалося розпізнати зображення.";
  } catch (err) {
    return "📸 Зображення отримано, але модель moondream зараз не запущена. Завантажте її командою: ollama pull moondream.";
  }
}

// 5. Головна функція-диспетчер запитів
async function handleAssistantRequest(req, res) {
  try {
    const message = req.body.query || req.body.message || "";
    const imageBase64 = req.body.image || null;
    const history = Array.isArray(req.body.history) ? req.body.history : [];

    console.log(`[Запит клієнта]: "${message}" | Зображення: ${imageBase64 ? 'Так' : 'Ні'}`);

    // Перевірка наявності зображення
    if (imageBase64) {
      const visionResult = await processImageRequest(imageBase64, message);
      return res.json({ reply: visionResult });
    }

    // Рівень 1: Швидка база знань
    const directKnowledge = checkDirectKnowledge(message);
    if (directKnowledge) {
      return res.json({ reply: directKnowledge });
    }

    // Рівень 2: Пошук по розкладу
    const { results: matchedClasses, entities } = await searchSchedule(message);
    const hasExplicitIntent = entities && (entities.teacher || entities.group || entities.day);

    if (matchedClasses.length > 0 && hasExplicitIntent) {
      const scheduleContext = matchedClasses.map(c => 
        `- ${c.day}, ${c.period} пара: ${c.subject} (${c.type}), викладач: ${c.teacher}, ауд: ${c.room}, група: ${c.group}`
      ).join("\n");

      const answerPrompt = `Ти — університетський цифровий асистент ННІФТКН ЧНУ ім. Юрія Федьковича. Спілкуйся природно, ввічливо та живо українською мовою. 
Не створюй сухих довгих списків, якщо можна пояснити зрозумілими людськими реченнями.

Запитання студента: "${message}"

Знайдені записи в базі:
${scheduleContext}

Склади чітку, дружню відповідь на основі цих даних (вкажи викладача або групу, час чи номер пари та аудиторію).`;

      try {
        const resAi = await openai.chat.completions.create({
          model: "qwen2.5:3b",
          messages: [{ role: "user", content: answerPrompt }],
          temperature: 0.1,
          max_tokens: 1400
        });

        let naturalReply = resAi.choices[0]?.message?.content || "";
        naturalReply = naturalReply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

        if (naturalReply) {
          return res.json({ reply: naturalReply });
        }
      } catch (err) {
        console.warn("[Natural Reply Fallback]:", err.message);
      }

      // Якщо Qwen раптом не відповіла — віддаємо структурований вивід
      const fallbackList = matchedClasses.map(c => 
        `• ${c.day} | ${c.period} пара: ${c.subject}\n   ${c.teacher} | ${c.room} | гр. ${c.group}`
      ).join("\n\n");
      return res.json({ reply: `Ось що вдалося знайти в розкладі:\n\n${fallbackList}` });
    }

    if (hasExplicitIntent && matchedClasses.length === 0) {
      return res.json({
        reply: "Я перевірив базу розкладу, але відповідних пар не знайшов. Спробуйте уточнити день, прізвище або номер групи."
      });
    }

    // Рівень 3: Звичайна жива розмова (привітання, загальні питання)
    const now = new Date();
    const systemPrompt = `Ти — дружній цифровий помічник студентів і викладачів інституту ННІФТКН ЧНУ ім. Юрія Федьковича. 
Спілкуйся природно, привітно і невимушено українською мовою. 
Якщо студент вітається — привітайся у відповідь і запропонуй допомогу з розкладом пар, викладачами, аудиторіями чи деканатом. Не вигадуй розклади від себе.

ДОВІДНИК ІНСТИТУТУ:
${JSON.stringify(knowledgeBase, null, 2)}`;

    const messagesPayload = [
      { role: "system", content: systemPrompt },
      ...history.slice(-4),
      { role: "user", content: message }
    ];

    const completion = await openai.chat.completions.create({
      model: "qwen2.5:3b",
      messages: messagesPayload,
      temperature: 0.4,
      max_tokens: 250
    });

    let botReply = completion.choices[0]?.message?.content || "";
    botReply = botReply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    return res.json({
      reply: botReply || "Привіт! Я помічник ННІФТКН. Можу підказати пари викладачів, розклад вашої групи або контакти деканату. Чим допомогти?"
    });

  } catch (error) {
    console.error("[Handler Error]:", error.message);
    return res.json({
      reply: "🏛️ Деканат ННІФТКН розташований у Корпусі №9 (вул. Сторожинецька, 101, 2-й поверх). Графік роботи: пн-пт з 08:30 до 17:00."
    });
  }
}

// Роути для API
app.post('/api/assistant', handleAssistantRequest);
app.post('/assistant', handleAssistantRequest);
app.post('/api/chat', handleAssistantRequest);
app.post('/chat', handleAssistantRequest);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер ННІФТКН запущено на http://localhost:${PORT}`);
});