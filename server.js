const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// URL оригінального розкладу інституту для авто-актуалізації
const REMOTE_SCHEDULE_URL = "https://raw.githubusercontent.com/shpatar26121974/nniftcn_schedule/main/data/schedule.json";

// Сітка дзвінків ЧНУ
const CALLS_MAP = {
  1: "08:20 – 09:40",
  2: "09:50 – 11:10",
  3: "11:30 – 12:50",
  4: "13:00 – 14:20",
  5: "14:40 – 16:00",
  6: "16:10 – 17:30"
};

const DAYS_UA = {
  0: "Неділя",
  1: "Понеділок",
  2: "Вівторок",
  3: "Середа",
  4: "Четвер",
  5: "П'ятниця",
  6: "Субота"
};

let scheduleData = [];

// Функція завантаження з локального диска
function loadLocalSchedule() {
  try {
    const filePath = path.join(__dirname, 'schedule.json');
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      scheduleData = JSON.parse(raw);
      console.log(`✅ Базу знань ННІФТКН завантажено: ${scheduleData.length} занять.`);
    }
  } catch (err) {
    console.error("Помилка читання локального schedule.json:", err.message);
  }
}

// Функція авто-актуалізації з віддаленого сервера
function syncRemoteSchedule() {
  console.log("🔄 Перевірка оновлень розкладу інституту...");
  https.get(REMOTE_SCHEDULE_URL, (res) => {
    if (res.statusCode !== 200) {
      console.warn(`Не вдалося оновити базу онлайн, код відповіді: ${res.statusCode}`);
      return;
    }
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed) && parsed.length > 0) {
          scheduleData = parsed;
          fs.writeFileSync(path.join(__dirname, 'schedule.json'), data, 'utf-8');
          console.log(`🚀 Базу знань оновлено онлайн: ${scheduleData.length} занять збережено.`);
        }
      } catch (e) {
        console.error("Помилка парсингу онлайн-оновлення розкладу:", e.message);
      }
    });
  }).on('error', (e) => {
    console.warn("Мережева помилка синхронізації:", e.message);
  });
}

// Ініціалізація та періодичний sync кожні 6 годин
loadLocalSchedule();
syncRemoteSchedule();
setInterval(syncRemoteSchedule, 6 * 60 * 60 * 1000);

// Ендпоінт ручної примусової синхронізації
app.post('/api/sync', (req, res) => {
  syncRemoteSchedule();
  res.json({ status: "Синхронізацію запущено", currentRecords: scheduleData.length });
});

function cleanText(str) {
  return (str || "").toLowerCase().replace(/['`’ʼ]/g, "").trim();
}

// Дедуплікація повторюваних записів для потоків
function deduplicateLessons(lessons) {
  const map = new Map();
  lessons.forEach(l => {
    const key = `${l.day}_${l.period}_${l.week}_${cleanText(l.subject)}_${cleanText(l.room)}`;
    if (map.has(key)) {
      const existing = map.get(key);
      if (l.group && !existing.group.includes(l.group)) {
        existing.group += `, ${l.group}`;
      }
    } else {
      map.set(key, { ...l });
    }
  });
  return Array.from(map.values()).sort((a, b) => (a.period || 0) - (b.period || 0));
}

// Форматування карток занять для студента або викладача
function formatLessonList(lessons, isGroupView = false) {
  const deduped = deduplicateLessons(lessons);
  return deduped.map(l => {
    const time = CALLS_MAP[l.period] || "";
    const week = l.week ? ` (Тиждень ${l.week})` : "";
    const room = l.room || "онлайн";
    const subInfo = isGroupView 
      ? `👨‍🏫 <i>${l.teacher || 'Викладач кафедри'}</i>, 📍 <i>${room}</i>`
      : `📍 <i>${room}</i>, група: <b>${l.group || '-'}</b>`;

    return `• <b>${l.period} пара (${time})</b>: ${l.subject}${week}<br>&nbsp;&nbsp;${subInfo}`;
  }).join("<br>");
}

app.post('/api/assistant', (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ reply: "Порожній запит." });

  const text = query.trim();
  const cleanQuery = cleanText(text);

  const now = new Date();
  const hour = now.getHours();
  const currentDay = now.getDay(); // 0 = Нд, 1 = Пн ... 6 = Сб

  let greeting = "Доброго дня";
  if (hour >= 23 || hour < 6) greeting = "Доброї ночі";
  else if (hour < 11) greeting = "Доброго ранку";
  else if (hour >= 18) greeting = "Доброго вечора";

  // Визначення дня
  let targetDay = null;
  let isTomorrow = false;

  if (cleanQuery.includes("завтра")) {
    targetDay = (currentDay + 1) % 7;
    isTomorrow = true;
  } else if (cleanQuery.includes("сьогодні")) {
    targetDay = currentDay;
  } else if (cleanQuery.includes("понеділ")) targetDay = 1;
  else if (cleanQuery.includes("вівтор")) targetDay = 2;
  else if (cleanQuery.includes("серед")) targetDay = 3;
  else if (cleanQuery.includes("четвер")) targetDay = 4;
  else if (cleanQuery.includes("п'ятниц") || cleanQuery.includes("пятниц")) targetDay = 5;

  // 1. ПОШУК ЗА НОМЕРОМ ГРУПИ (наприклад: "124", "441", "343", "111")
  const groupMatch = text.match(/\b([1-6]\d{2}[а-яіїєґa-z]*)\b/i);
  let matchedGroup = groupMatch ? groupMatch[1].toLowerCase() : null;

  let groupLessons = [];
  if (matchedGroup) {
    groupLessons = scheduleData.filter(item => {
      if (!item.group) return false;
      const gClean = cleanText(item.group);
      return gClean.includes(matchedGroup);
    });
  }

  if (groupLessons.length > 0) {
    const groupName = matchedGroup.toUpperCase();

    // Якщо вказано конкретний день для групи
    if (targetDay !== null) {
      const targetDayName = DAYS_UA[targetDay];
      if (targetDay === 0 || targetDay === 6) {
        return res.json({
          reply: `<b>Група ${groupName}:</b> ${isTomorrow ? "Завтра" : "Цей день"} (${targetDayName}) — вихідний, занять немає.`
        });
      }

      const dayLessons = groupLessons.filter(l => cleanText(l.day).includes(cleanText(targetDayName)));
      if (dayLessons.length > 0) {
        return res.json({
          reply: `
            <strong style="color:#1c355e; font-size:14px;">Розклад групи ${groupName} на ${isTomorrow ? "завтра" : targetDayName} (${targetDayName}):</strong><br><br>
            ${formatLessonList(dayLessons, true)}
          `
        });
      } else {
        const days = [...new Set(groupLessons.map(l => l.day))].join(", ");
        return res.json({
          reply: `Для групи <b>${groupName}</b> на ${targetDayName} занять за розкладом немає.<br>📅 Дні із заняттями: ${days}.`
        });
      }
    }

    // Розклад на весь тиждень для групи
    const weekDays = ["Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця"];
    let weekHtml = "";
    weekDays.forEach(d => {
      const dLessons = groupLessons.filter(l => cleanText(l.day).includes(cleanText(d)));
      if (dLessons.length > 0) {
        weekHtml += `<div style="margin-top:10px;"><b>📅 ${d}:</b><br>${formatLessonList(dLessons, true)}</div>`;
      }
    });

    return res.json({
      reply: `
        <strong style="color:#1c355e; font-size:14px;">Розклад занять групи ${groupName} (ННІФТКН):</strong><br>
        ${weekHtml || "Занять у базі не знайдено."}
      `
    });
  }

  // 2. ПОШУК ЗА ВИКЛАДАЧЕМ (якщо це не запит по групі)
  const tokens = cleanQuery.split(/[^a-zа-яіїєґ0-9]+/).filter(w => w.length >= 4);
  const teacherLessons = scheduleData.filter(item => {
    if (!item.teacher) return false;
    const cleanTeacher = cleanText(item.teacher);
    return tokens.some(tok => cleanTeacher.includes(tok));
  });

  if (teacherLessons.length > 0) {
    const teacherName = teacherLessons[0].teacher;

    if (targetDay !== null) {
      const targetDayName = DAYS_UA[targetDay];
      if (targetDay === 0 || targetDay === 6) {
        return res.json({
          reply: `<b>${greeting}, ${teacherName}!</b><br>${isTomorrow ? "Завтра" : "Цей день"} (${targetDayName}) — вихідний, занять немає.`
        });
      }

      const dayLessons = teacherLessons.filter(l => cleanText(l.day).includes(cleanText(targetDayName)));
      if (dayLessons.length > 0) {
        return res.json({
          reply: `
            <strong style="color:#1c355e; font-size:14px;">${greeting}, ${teacherName}!</strong><br>
            Розклад на <b>${isTomorrow ? "завтра" : targetDayName} (${targetDayName})</b>:<br><br>
            ${formatLessonList(dayLessons, false)}
          `
        });
      } else {
        const availableDays = [...new Set(teacherLessons.map(l => l.day))].join(", ");
        return res.json({
          reply: `<b>${greeting}, ${teacherName}!</b><br>На ${targetDayName} занять за розкладом немає.<br>📅 Дні із заняттями: ${availableDays}`
        });
      }
    }

    const weekDays = ["Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця"];
    let fullHtml = "";
    weekDays.forEach(day => {
      const dayLessons = teacherLessons.filter(l => cleanText(l.day).includes(cleanText(day)));
      if (dayLessons.length > 0) {
        fullHtml += `<div style="margin-top:10px;"><b>📅 ${day}:</b><br>${formatLessonList(dayLessons, false)}</div>`;
      }
    });

    return res.json({
      reply: `
        <strong style="color:#1c355e; font-size:14px;">Розклад викладача: ${teacherName}</strong><br>
        ${fullHtml || "Занять у базі не знайдено."}
      `
    });
  }

  // 3. ІНФОРМАЦІЯ ПО ННІФТКН
  if (cleanQuery.includes("деканат") || cleanQuery.includes("дирекці")) {
    return res.json({
      reply: "<b>Дирекція та деканат ННІФТКН:</b><br>📍 Корпус №9, вул. Сторожинецька, 101, 2-й поверх.<br>📞 Телефон: (0372) 54-71-73<br>✉️ Email: iftcs@chnu.edu.ua"
    });
  }

  if (cleanQuery.includes("дзвінк") || cleanQuery.includes("розклад пар")) {
    const calls = Object.entries(CALLS_MAP).map(([p, t]) => `• ${p} пара: ${t}`).join("<br>");
    return res.json({ reply: `<b>Сітка дзвінків ННІФТКН (Корпус №9):</b><br>${calls}` });
  }

  return res.json({
    reply: `Вкажіть номер групи (наприклад: <i>"розклад 124 групи"</i>) або прізвище викладача (<i>"розклад Рябого у вівторок"</i>).`
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер ННІФТКН працює на порту ${PORT}`);
});