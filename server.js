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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// КОНФІГУРАЦІЯ МОДЕЛЕЙ
// ==========================================
const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const CHAT_MODEL = process.env.MODEL_NAME || 'qwen2.5:7b';
const VISION_MODEL = process.env.VISION_MODEL || 'moondream';

const openai = new OpenAI({
  baseURL: OLLAMA_BASE.endsWith('/v1') ? OLLAMA_BASE : `${OLLAMA_BASE}/v1`,
  apiKey: 'ollama',
});

// ==========================================
// ШАР 1: OBSERVABILITY / TRACES (JSON замість SQLite)
// ==========================================
const tracesPath = path.join(__dirname, 'traces.json');
if (!fs.existsSync(tracesPath)) {
  fs.writeFileSync(tracesPath, '[]', 'utf-8');
}

function recordTrace({ query, entities = null, layerHit, startTime, status, reply }) {
  const latency = Date.now() - startTime;
  try {
    const traces = JSON.parse(fs.readFileSync(tracesPath, 'utf-8') || '[]');
    traces.unshift({
      id: Date.now(),
      timestamp: new Date().toISOString(),
      query,
      entities: entities ? JSON.stringify(entities) : null,
      layer_hit: layerHit,
      latency_ms: latency,
      status,
      reply: reply ? reply.substring(0, 500) : '',
    });
    fs.writeFileSync(tracesPath, JSON.stringify(traces.slice(0, 100), null, 2), 'utf-8');
  } catch (e) {
    console.error('[Trace Error]:', e.message);
  }
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
  /<script>/i,
];

const TOXIC_PATTERNS = [
  /\b(хуй|пізд|єбат|бляд|сука|мудак|гандон|чмо)\b/i,
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
      return { passed: false, reason: 'PROMPT_INJECTION', message: 'Запит заблоковано системою безпеки інфо-кіоску ННІФТКН.' };
    }
  }
  for (const pattern of TOXIC_PATTERNS) {
    if (pattern.test(query)) {
      return { passed: false, reason: 'TOXICITY', message: 'Будь ласка, дотримуйтесь академічної доброчесності та культури мовлення.' };
    }
  }
  return { passed: true };
}

// ==========================================
// ШАР 3: БАЗА ЗНАНЬ
// ==========================================
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
  console.log(`[Ініціалізація] Записів розкладу: ${scheduleData.length} | Викладачів у базі: ${Object.keys(knowledgeBase.teachers || {}).length}`);
} catch (err) {
  console.error('[Помилка] Збій читання JSON-файлів:', err.message);
}

const CALL_SCHEDULE = `⏰ Розклад дзвінків ННІФТКН:
- 1 пара: 08:20 – 09:40
- 2 пара: 09:50 – 11:10
- 3 пара: 11:30 – 12:50
- 4 пара: 13:00 – 14:20
- 5 пара: 14:40 – 16:00
- 6 пара: 16:10 – 17:30`;

const DAYS_MAP = ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', "п'ятниця", 'субота'];

// Нормалізація + захист від випадкових латинських літер (i, o, a, e, c, p, x)
const normalize = (str) =>
  (str || '')
    .toLowerCase()
    .replace(/i/g, 'і')
    .replace(/o/g, 'о')
    .replace(/a/g, 'а')
    .replace(/e/g, 'е')
    .replace(/c/g, 'с')
    .replace(/p/g, 'р')
    .replace(/x/g, 'х')
    .replace(/['’`ʼ]/g, '')
    .trim();

// Правильний стемінг українських прізвищ (Рябий / Рябого / Рябому -> ряб)
function getSurnameStem(surname) {
  const clean = normalize(surname).replace(/[^а-яіїєґ]/g, '');
  if (clean.length <= 3) return clean;
  if (clean.length <= 5) return clean.slice(0, 3); // "рябий" -> "ряб"
  return clean.replace(/(ого|ому|ою|ої|ими|іми|ами|ями|ях|ах|ов|ев|єв|ий|ій|а|я|у|ю|о|е|і|и)$/, '');
}

// ==========================================
// ШАР 4: ROUTER & FAST-CACHE (Без виклику LLM)
// ==========================================
function checkDirectKnowledge(query) {
  const q = normalize(query);
  if (q.includes('як тебе звати') || q.includes('хто ти') || q.includes('що ти вмієш')) {
    return 'Я — цифровий асистент та навігатор ННІФТКН ЧНУ ім. Юрія Федьковича. Допомагаю знайти розклад занять, інформацію про викладачів, аудиторії, контакти деканату та розпізнати оголошення зі стендів.';
  }
  if (q.includes('дзвін') || q.includes('пари коли') || q.includes('початок пар') || q.includes('сітка')) {
    return CALL_SCHEDULE;
  }

  if (q.includes('деканат') || q.includes('декан') || q.includes('заступник') || q.includes('телефон') || q.includes('номер') || q.includes('подзвонити')) {
    const deanery = knowledgeBase.deanery || knowledgeBase.contacts?.deanery || knowledgeBase['деканат'];
    if (deanery) {
      if (typeof deanery === 'string') return `🏛️ Інформація про деканат:\n${deanery}`;
      return `🏛️ Деканат ННІФТКН:\nАдреса: ${deanery.address || 'вул. Сторожинецька, 101, Корпус №9'}\nКабінет: ${deanery.room || deanery.office || '2-й поверх'}\nТелефон: ${deanery.phone || '(0372) 54-71-73'}\nГодини роботи: ${deanery.working_hours || '08:30 – 17:00'}\nПошта: ${deanery.email || 'iftcs@chnu.edu.ua'}`;
    }
    return `🏛️ Деканат ННІФТКН:\nАдреса: вул. Сторожинецька, 101 (Корпус №9, 2-й поверх)\nТелефон: (0372) 54-71-73\nEmail: iftcs@chnu.edu.ua\nГрафік роботи: пн–пт з 08:30 до 17:00.`;
  }

  if (q.includes('корпус') || q.includes('адрес') || q.includes('де знаходиться інститут') || q.includes('де вхід') || q.includes('сторожинецька')) {
    if (knowledgeBase.commonInfo?.buildings) {
      const buildingsList = knowledgeBase.commonInfo.buildings.map((b) => `• ${b.name}: ${b.address}`).join('\n');
      return `📍 Корпуси та адреси:\n${buildingsList}`;
    }
    return `📍 ННІФТКН ЧНУ ім. Юрія Федьковича:\nОсновна адреса: м. Чернівці, вул. Сторожинецька, 101 (Корпус №9)`;
  }

  return null;
}

// ==========================================
// ШАР 5: ENTITY PARSER & RAG
// ==========================================
function extractEntities(userQuery) {
  const q = normalize(userQuery);
  const queryWords = q.split(/[\s,?.!;:()\-]+/).filter((w) => w.length >= 3);
  const now = new Date();

  let day = null;
  if (q.includes('сьогодні')) day = DAYS_MAP[now.getDay()];
  else if (q.includes('завтра')) day = DAYS_MAP[(now.getDay() + 1) % 7];
  else if (q.includes('післязавтра')) day = DAYS_MAP[(now.getDay() + 2) % 7];
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
  if (q.includes('фесів') || q.includes('феськ')) {
    teacher = 'Фесів';
  } else {
    // 1. Пошук по словнику knowledgeBase.teachers
    const teacherKeys = Object.keys(knowledgeBase.teachers || {});
    for (const key of teacherKeys) {
      const surname = key.split(/[\s.]+/)[0];
      const stem = getSurnameStem(surname);
      if (stem.length >= 3 && queryWords.some((w) => w.startsWith(stem))) {
        teacher = key;
        break;
      }
    }

    // 2. Пошук напряму по scheduleData
    if (!teacher && Array.isArray(scheduleData)) {
      for (const item of scheduleData) {
        if (!item.teacher) continue;
        const cleaned = item.teacher.replace(/(ас\.|доц\.|проф\.|викл\.|каф\.|ст\.)/gi, '').trim();
        const firstWord = cleaned.split(/[\s.]+/)[0];
        const stem = getSurnameStem(firstWord);
        if (stem.length >= 3 && queryWords.some((w) => w.startsWith(stem))) {
          teacher = firstWord;
          break;
        }
      }
    }
  }

  return { teacher, group, day };
}

function matchTeacherInRecord(itemTeacher, targetTeacher) {
  if (!targetTeacher) return true;
  const t = normalize(itemTeacher);
  const normTarget = normalize(targetTeacher.split(/[\s.]+/)[0]);
  if (normTarget.includes('фесів')) return t.includes('фесів') || t.includes('феськ');
  const stem = getSurnameStem(normTarget);
  return t.includes(stem);
}

function matchGroupInRecord(itemGroup, targetGroup) {
  if (!targetGroup) return true;
  const g = normalize(itemGroup);
  return g === targetGroup || new RegExp(`\\b${targetGroup}\\b`).test(g);
}

function searchSchedule(query) {
  if (!Array.isArray(scheduleData) || scheduleData.length === 0) {
    return { results: [], entities: null, exactDayEmpty: false };
  }

  const entities = extractEntities(query);
  const targetGroup = entities.group ? normalize(entities.group) : null;
  const targetDay = entities.day ? normalize(entities.day) : null;

  if (!entities.teacher && !targetGroup && !targetDay) {
    return { results: [], entities, exactDayEmpty: false };
  }

  // 1. Точний пошук (Група / Викладач + День)
  let results = scheduleData.filter((item) => {
    if (!matchTeacherInRecord(item.teacher, entities.teacher)) return false;
    if (!matchGroupInRecord(item.group, targetGroup)) return false;
    if (targetDay && !normalize(item.day).includes(targetDay.slice(0, 4))) return false;
    return true;
  });

  let exactDayEmpty = false;

  // 2. Якщо в цей день пар немає — беремо пари викладача/групи за весь тиждень
  if (results.length === 0 && targetDay && (targetGroup || entities.teacher)) {
    exactDayEmpty = true;
    results = scheduleData.filter((item) => {
      if (!matchTeacherInRecord(item.teacher, entities.teacher)) return false;
      if (!matchGroupInRecord(item.group, targetGroup)) return false;
      return true;
    });
  }

  return { results: results.slice(0, 30), entities, exactDayEmpty };
}

// ==========================================
// VISION ОБРОБКА ЧЕРЕЗ MOONDREAM
// ==========================================
async function processImageRequest(imageBase64, userPrompt) {
  const promptText = userPrompt || 'Прочитай розклад або оголошення на цьому фото та структуруй інформацію.';
  const cleanBase64 = imageBase64.replace(/^data:image\/[a-z]+;base64,/, '');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 40000);

  try {
    const nativeOllamaUrl = OLLAMA_BASE.replace(/\/v1\/?$/, '');
    const response = await fetch(`${nativeOllamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: VISION_MODEL,
        prompt: promptText,
        images: [cleanBase64],
        stream: false,
      }),
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return '⚠️ Модель зору moondream повернула помилку. Перевірте статус Ollama.';
    }

    const data = await response.json();
    return data.response ? data.response.trim() : 'Не вдалося розпізнати текст на фото.';
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      return '⏱️ Час очікування розпізнавання фото минув. Спробуйте зображення меншого розміру.';
    }
    return `📸 Помилка обробки фото: ${err.message}`;
  }
}

// ==========================================
// ДОПОМІЖНІ ФУНКЦІЇ СТРІМІНГУ ВІДПОВІДІ (ОПТИМІЗОВАНО ПІД ШВИДКІСТЬ)
// ==========================================
function initStreamHeaders(res) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
}

async function streamLLMToResponse({ res, messages, temperature = 0.1, maxTokens = 500, numCtx = 2048, query, entities = null, layerHit, startTime }) {
  initStreamHeaders(res);
  let fullReply = '';

  try {
    const nativeOllamaUrl = OLLAMA_BASE.replace(/\/v1\/?$/, '');
    const response = await fetch(`${nativeOllamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages,
        stream: true,
        keep_alive: -1, // Тримає модель у пам'яті постійно
        options: {
          num_ctx: numCtx,
          num_predict: maxTokens,
          temperature,
          top_k: 20,
          repeat_penalty: 1.1,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          const content = parsed.message?.content || '';
          if (content) {
            fullReply += content;
            res.write(content);
          }
        } catch (_) {}
      }
    }

    res.end();
    recordTrace({
      query,
      entities,
      layerHit,
      startTime,
      status: 'SUCCESS_STREAM',
      reply: fullReply,
    });
  } catch (err) {
    console.error(`[STREAM Error - ${layerHit}]:`, err.message);
    if (!fullReply) {
      res.write('⚠️ Не вдалося отримати відповідь від моделі. Перевірте, чи запущена Ollama.');
    }
    res.end();
    recordTrace({
      query,
      entities,
      layerHit,
      startTime,
      status: 'STREAM_ERROR',
      reply: fullReply || err.message,
    });
  }
}

// ==========================================
// ШАР 6: ГОЛОВНИЙ DISPATCHER (ПОТОКОВИЙ)
// ==========================================
async function handleAssistantRequest(req, res) {
  const startTime = Date.now();
  const message = req.body.query || req.body.message || '';
  const imageBase64 = req.body.image || null;
  const history = Array.isArray(req.body.history) ? req.body.history : [];

  // 1. Guardrails
  if (!imageBase64) {
    const guard = runGuardrails(message);
    if (!guard.passed) {
      recordTrace({ query: message, layerHit: 'GUARDRAILS_REJECT', startTime, status: guard.reason, reply: guard.message });
      initStreamHeaders(res);
      return res.end(guard.message);
    }
  }

  // 2. Vision Request
  if (imageBase64) {
    const visionReply = await processImageRequest(imageBase64, message);
    recordTrace({ query: message || '[IMAGE_PROMPT]', layerHit: 'MOONDREAM_VISION', startTime, status: 'SUCCESS', reply: visionReply });
    initStreamHeaders(res);
    return res.end(visionReply);
  }

  // 3. Fast-Cache / Router
  const direct = checkDirectKnowledge(message);
  if (direct) {
    recordTrace({ query: message, layerHit: 'FAST_CACHE', startTime, status: 'SUCCESS', reply: direct });
    initStreamHeaders(res);
    return res.end(direct);
  }

  // 4. RAG Search & LLM Synthesis (потоково)
  const { results: matchedClasses, entities, exactDayEmpty } = searchSchedule(message);
  const hasExplicitIntent = entities && (entities.teacher || entities.group || entities.day);

  // 4.1. Інформація про викладача (біографія + групи + предмети)
  const qNorm = normalize(message);
  const isBioQuery =
    entities?.teacher &&
    (qNorm.includes('хто так') ||
      qNorm.includes('хто це') ||
      qNorm.includes('про викладач') ||
      qNorm.includes('інформація про') ||
      qNorm.includes('кафедр') ||
      qNorm.includes('посад') ||
      qNorm.includes('біограф') ||
      qNorm.includes('що викладає') ||
      qNorm.includes('які предмети') ||
      qNorm.includes('у яких груп') ||
      qNorm.includes('в яких груп') ||
      qNorm.includes('які груп')) &&
    !qNorm.includes('розклад') &&
    !qNorm.includes('коли пара') &&
    !qNorm.includes('сьогодні') &&
    !qNorm.includes('завтра');

  if (isBioQuery) {
    const allTeacherClasses = scheduleData.filter((item) => matchTeacherInRecord(item.teacher, entities.teacher));

    const uniqueSubjects = [...new Set(allTeacherClasses.map((c) => c.subject).filter(Boolean))];
    const uniqueGroups = [...new Set(allTeacherClasses.map((c) => c.group).filter(Boolean))];
    const scheduleName = allTeacherClasses[0]?.teacher || entities.teacher;

    const teachersDict = knowledgeBase.teachers || {};
    const matchedKey = Object.keys(teachersDict).find((k) =>
      normalize(k).includes(getSurnameStem(entities.teacher.split(/[\s.]+/)[0]))
    );
    const bioData = matchedKey ? teachersDict[matchedKey] : null;

    const bioContext = bioData
      ? `ПІБ: ${bioData.fullName}\nПосада: ${bioData.position}\nБіографія: ${bioData.bio}`
      : `Ім'я в розкладі: ${scheduleName}`;

    const bioPrompt = `Ти — офіційний цифровий навігатор ННІФТКН ЧНУ ім. Юрія Федьковича.
Користувач запитує про викладача: "${message}".

Офіційна інформація про викладача:
${bioContext}

Дані з актуального розкладу занять:
- Дисципліни, які викладає: ${uniqueSubjects.join(', ') || 'не вказано'}
- Групи, у яких веде пари: ${uniqueGroups.join(', ') || 'не вказано'}

ПРАВИЛА ВІДПОВІДІ:
1. Сформуй чітку, структуровану довідку (3–4 речення або короткий список): хто це (ПІБ, посада, біографія), які предмети викладає та в яких групах веде пари.
2. НЕ виводь погодинний розклад по днях тижня та аудиторіях, якщо про це не питали.
3. Використовуй виключно наведені вище факти, нічого не вигадуй від себе.
4. У кінці одним реченням запропонуй: "Якщо потрібно, можу показати його точний розклад занять."`;

    return await streamLLMToResponse({
      res,
      messages: [{ role: 'user', content: bioPrompt }],
      temperature: 0.1,
      maxTokens: 400,
      numCtx: 1536,
      query: message,
      entities,
      layerHit: 'TEACHER_BIO_STREAM',
      startTime,
    });
  }

  // 4.2. Розклад занять
  if (matchedClasses.length > 0 && hasExplicitIntent) {
    const scheduleContext = matchedClasses
      .map((c) => `- ${c.day}, ${c.period} пара: ${c.subject} (${c.type}), викладач: ${c.teacher}, ауд: ${c.room}, група: ${c.group}`)
      .join('\n');

    const dayNote =
      exactDayEmpty && entities.day
        ? `ВАЖЛИВО: На "${entities.day}" занять у розкладі немає (вільний день). Першим реченням прямо напиши, що у цей день пар немає, а нижче виведи наявний розклад на інші дні тижня з контексту.`
        : '';

    const answerPrompt = `Ти — офіційний цифровий навігатор інституту ННІФТКН ЧНУ ім. Юрія Федьковича.
Дай структуровану, чітку відповідь студенту українською мовою на основі даних розкладу.
${dayNote}

ПРАВИЛА:
1. НЕ пиши вступних фраз на зразок "За вашим запитом знайдено...".
2. Не вигадуй жодних даних від себе, спирайся виключно на наданий контекст.
3. Подавай розклад чіткими блоками: день, номер пари, назва дисципліни, викладач, аудиторія.

Запитання: "${message}"

Знайдені записи в базі розкладу:
${scheduleContext}`;

    return await streamLLMToResponse({
      res,
      messages: [{ role: 'user', content: answerPrompt }],
      temperature: 0.1,
      maxTokens: 800,
      numCtx: 2048,
      query: message,
      entities,
      layerHit: 'RAG_LLM_STREAM',
      startTime,
    });
  }

  if (hasExplicitIntent && matchedClasses.length === 0) {
    const notFoundReply = 'За цим запитом пар не знайдено. Перевірте правильність написання прізвища викладача або номера групи.';
    recordTrace({ query: message, entities, layerHit: 'RAG_NOT_FOUND', startTime, status: 'EMPTY_RESULT', reply: notFoundReply });
    initStreamHeaders(res);
    return res.end(notFoundReply);
  }

  // 5. Загальне спілкування (БЕЗ commonInfo, щоб не вигадувало корпуси на невідомі прізвища)
  const systemPrompt = `Ти — ввічливий цифровий помічник студентів інституту ННІФТКН ЧНУ ім. Юрія Федьковича.
Відповідай стисло (2–3 речення) та українською мовою.
Контакти деканату: вул. Сторожинецька, 101 (Корпус №9), тел. (0372) 54-71-73, email: iftcs@chnu.edu.ua.
Якщо користувач запитує про людину чи розклад, яких немає в базі — чесно скажи, що не маєш інформації про цього викладача або групу, і попроси уточнити прізвище чи номер групи.`;

  return await streamLLMToResponse({
    res,
    messages: [
      { role: 'system', content: systemPrompt },
      ...history.slice(-4),
      { role: 'user', content: message },
    ],
    temperature: 0.2,
    maxTokens: 250,
    numCtx: 1024,
    query: message,
    entities,
    layerHit: 'GENERAL_CHAT_STREAM',
    startTime,
  });
}

// ==========================================
// API АНАЛІТИКИ ТА ЕНДПОІНТИ
// ==========================================
app.get('/api/analytics', (req, res) => {
  try {
    const rows = JSON.parse(fs.readFileSync(tracesPath, 'utf-8') || '[]').slice(0, 50);
    res.json(rows);
  } catch (e) {
    res.json([]);
  }
});

app.post('/api/assistant', handleAssistantRequest);
app.post('/assistant', handleAssistantRequest);
app.post('/api/chat', handleAssistantRequest);
app.post('/chat', handleAssistantRequest);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущено на http://localhost:${PORT} (Модель: ${CHAT_MODEL}, Vision: ${VISION_MODEL})`);
});