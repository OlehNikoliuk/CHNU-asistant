// services/scheduler.js
import fs from 'fs';
import path from 'path';

// Завантажуємо розклад при старті сервера
const rawSchedule = JSON.parse(
  fs.readFileSync(path.resolve('./schedule_2026.json'), 'utf-8')
);

// Мапа днів тижня для Date.getDay()
const DAYS_MAP = [
  'неділя',
  'понеділок',
  'вівторок',
  'середа',
  'четвер',
  'пʼятниця',
  'субота'
];

/**
 * Отримуємо день тижня українською
 */
export function getDayName(targetDate = new Date()) {
  return DAYS_MAP[targetDate.getDay()];
}

/**
 * Нормалізація назви групи (прибирає пробіли, дефіси та регістр)
 * "124-а", "124 А", "124а" -> "124а"
 */
function normalizeGroupName(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/[\s\-_]/g, '');
}

/**
 * Детермінований пошук пар
 */
export function findLessons({ group, day = null, date = new Date() }) {
  const targetDay = (day || getDayName(date)).toLowerCase().trim();

  if (targetDay === 'субота' || targetDay === 'неділя') {
    return {
      status: 'weekend',
      message: 'Вихідний день. Пар за розкладом немає.'
    };
  }

  const normalizedTargetGroup = normalizeGroupName(group);

  // Фільтруємо за днем та групою
  const lessons = rawSchedule.filter((item) => {
    const itemDay = item.day ? item.day.toLowerCase().trim() : '';
    const itemGroup = normalizeGroupName(item.group);

    const matchDay = itemDay === targetDay;
    const matchGroup = !normalizedTargetGroup || itemGroup === normalizedTargetGroup;

    return matchDay && matchGroup;
  });

  // Сортуємо строго по порядку пар (поле period)
  lessons.sort((a, b) => (Number(a.period) || 0) - (Number(b.period) || 0));

  if (lessons.length === 0) {
    return {
      status: 'not_found',
      day: targetDay,
      group: group || 'не вказано',
      message: `На день «${targetDay}» пар для групи «${group || 'всіх'}» не знайдено.`
    };
  }

  return {
    status: 'ok',
    day: targetDay,
    group: group || 'загальний',
    total: lessons.length,
    lessons: lessons.map(l => ({
      period: l.period,
      subject: l.subject,
      teacher: l.teacher,
      room: l.room,
      type: l.type
    }))
  };
}