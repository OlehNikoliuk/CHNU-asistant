// services/aiGateway.js

const SYSTEM_PROMPT = `
Ти — офіційний віртуальний асистент деканату факультету (Чернівецький національний університет).
Твоя задача — надавати чіткі, достовірні та ділові відповіді студентам і викладачам.

ПРАВИЛА РОБОТИ:
1. СТИЛЬ: Офіційно-діловий, стриманий, ввічливий. Звертайся до користувача на «Ви».
2. ДЖЕРЕЛО ПРАВДИ: Використовуй ТІЛЬКИ інформацію з блоку «НАДАНІ ФАКТИ ДЕКАНАТУ».
3. ЗАХИСТ ВІД ГАЛЮЦИНАЦІЙ: Якщо в наданих фактах немає точної відповіді на питання, НЕ ВИГАДУЙ нічого. Напиши:
«На жаль, у базі даних деканату цієї інформації немає. Зверніться до деканату особисто (ауд. 210) у прийомні години.»
4. РОЗКЛАД: Якщо надано дані про пару, обов'язково вказуй: точний час/номер пари, назву дисципліни, тип (лекція/практика), викладача та номер аудиторії.
`;

/**
 * Відправляє сформований контекст у мовну модель
 */
export async function generateDeanResponse({ userMessage, retrievedContext, apiKey }) {
  const contextString = retrievedContext 
    ? JSON.stringify(retrievedContext, null, 2) 
    : 'Факти не знайдені.';

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: `${SYSTEM_PROMPT}\n\nНАДАНІ ФАКТИ ДЕКАНАТУ:\n${contextString}\n\nЗАПИТ СТУДЕНТА: ${userMessage}` }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1, // Жорстка детермінованість, без фантазій
      maxOutputTokens: 500
    }
  };

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }
  );

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`LLM API Error: ${response.status} - ${errorData}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Помилка формування відповіді.';
}