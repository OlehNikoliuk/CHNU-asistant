// services/vectorSearch.js
import fs from 'fs';
import path from 'path';

const kb = JSON.parse(
  fs.readFileSync(path.resolve('./data/knowledge_base.json'), 'utf-8')
);

/**
 * Токенізатор тексту для пошуку
 */
function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^а-яіїєґa-z0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter(word => word.length > 1);
}

/**
 * Пошук інформації в структурованій базі знань
 */
export function searchKnowledgeBase(userQuery) {
  const queryLower = userQuery.toLowerCase();
  const queryTokens = new Set(tokenize(userQuery));
  const results = [];

  // 1. Пошук розкладу дзвінків
  const callTriggers = ['дзвінок', 'дзвінки', 'пара починається', 'час пар', 'коли пара', 'коли починається'];
  if (callTriggers.some(t => queryLower.includes(t))) {
    results.push({
      type: 'calls_schedule',
      title: 'Розклад дзвінків факультету',
      data: kb.commonInfo.calls
    });
  }

  // 2. Пошук корпусів та адрес
  const buildingTriggers = ['корпус', 'адреса', 'де знаходиться', 'резиденція', 'матфак', 'сторожинецька'];
  if (buildingTriggers.some(t => queryLower.includes(t))) {
    const matchedBuildings = kb.commonInfo.buildings.filter(b => {
      const bText = `${b.name} ${b.address}`.toLowerCase();
      return tokenize(bText).some(token => queryTokens.has(token));
    });

    results.push({
      type: 'buildings',
      title: 'Адреси корпусів',
      data: matchedBuildings.length > 0 ? matchedBuildings : kb.commonInfo.buildings
    });
  }

  // 3. Пошук гуртожитків
  const dormTriggers = ['гуртожиток', 'гуртожитки', 'поселення', 'студмістечко', 'небесної сотні'];
  if (dormTriggers.some(t => queryLower.includes(t))) {
    results.push({
      type: 'dormitories',
      title: 'Дирекція студмістечка та гуртожитки',
      info: kb.commonInfo.dormitories
    });
  }

  // 4. Пошук викладача за аліасами та ПІБ
  if (kb.teachers && Array.isArray(kb.teachers)) {
    for (const teacher of kb.teachers) {
      const matchAlias = teacher.aliases?.some(alias => queryLower.includes(alias.toLowerCase()));
      const matchFullName = tokenize(teacher.fullName).some(token => queryTokens.has(token));

      if (matchAlias || matchFullName) {
        results.push({
          type: 'teacher_info',
          id: teacher.id,
          fullName: teacher.fullName,
          department: teacher.department,
          scheduleLoaded: teacher.scheduleLoaded,
          schedule: teacher.scheduleLoaded ? teacher.schedule : 'Розклад викладача ще формується'
        });
        break;
      }
    }
  }

  return results.length > 0 ? results : null;
}