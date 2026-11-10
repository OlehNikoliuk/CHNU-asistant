// public/widget.js
(function () {
  // Базова адреса бекенду на моноблоці (локальна або HTTPS тунелю)
  const API_URL = window.DEAN_API_URL || 'http://localhost:3000';

  // Створюємо ізольований контейнер
  const host = document.createElement('div');
  host.id = 'dean-assistant-root';
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

  // Стилі Shadow DOM
  const styles = `
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .dean-toggle-btn {
      position: fixed; bottom: 24px; right: 24px;
      width: 58px; height: 58px; border-radius: 50%;
      background: #1e3a8a; color: #fff; border: none;
      box-shadow: 0 4px 14px rgba(0,0,0,0.25); cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: transform 0.2s ease, background 0.2s; z-index: 999999;
    }
    .dean-toggle-btn:hover { transform: scale(1.05); background: #172554; }
    .dean-toggle-btn svg { width: 26px; height: 26px; fill: currentColor; }

    .dean-window {
      position: fixed; bottom: 94px; right: 24px;
      width: 380px; height: 560px; max-width: calc(100vw - 32px); max-height: calc(100vh - 120px);
      background: #ffffff; border-radius: 16px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.18);
      display: flex; flex-direction: column; overflow: hidden;
      border: 1px solid #e2e8f0; z-index: 999999;
      opacity: 0; pointer-events: none; transform: translateY(16px);
      transition: opacity 0.25s ease, transform 0.25s ease;
    }
    .dean-window.active { opacity: 1; pointer-events: auto; transform: translateY(0); }

    .dean-header {
      background: #1e3a8a; color: #fff; padding: 14px 16px;
      display: flex; align-items: center; justify-content: space-between;
    }
    .dean-header-info { display: flex; align-items: center; gap: 10px; }
    .dean-status-dot { width: 8px; height: 8px; background: #22c55e; border-radius: 50%; }
    .dean-title { font-weight: 600; font-size: 14px; margin: 0; }
    .dean-subtitle { font-size: 11px; opacity: 0.8; margin: 0; }

    .dean-group-select {
      background: #f8fafc; padding: 8px 14px; border-bottom: 1px solid #e2e8f0;
      display: flex; align-items: center; justify-content: space-between; font-size: 12px;
    }
    .dean-group-select input {
      border: 1px solid #cbd5e1; border-radius: 6px; padding: 4px 8px; font-size: 12px; width: 110px;
    }

    .dean-messages {
      flex: 1; padding: 14px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px;
      background: #f8fafc; font-size: 13px;
    }
    .msg { max-width: 82%; padding: 10px 12px; border-radius: 12px; line-height: 1.45; word-break: break-word; }
    .msg-bot { background: #ffffff; color: #0f172a; border: 1px solid #e2e8f0; align-self: flex-start; }
    .msg-user { background: #1e3a8a; color: #ffffff; align-self: flex-end; }

    .quick-chips { display: flex; gap: 6px; overflow-x: auto; padding: 8px 12px; background: #fff; border-top: 1px solid #e2e8f0; }
    .chip {
      background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 20px;
      padding: 4px 10px; font-size: 11px; white-space: nowrap; cursor: pointer; color: #334155;
    }
    .chip:hover { background: #e2e8f0; }

    .dean-input-area {
      padding: 10px 12px; background: #ffffff; border-top: 1px solid #e2e8f0;
      display: flex; gap: 8px; align-items: center;
    }
    .dean-input-area input {
      flex: 1; border: 1px solid #cbd5e1; border-radius: 8px; padding: 9px 12px;
      font-size: 13px; outline: none;
    }
    .dean-input-area input:focus { border-color: #1e3a8a; }
    .dean-send-btn {
      background: #1e3a8a; color: #fff; border: none; border-radius: 8px;
      padding: 9px 14px; font-size: 13px; cursor: pointer; font-weight: 500;
    }
  `;

  // HTML структура віджета
  const template = `
    <style>${styles}</style>
    
    <button class="dean-toggle-btn" id="toggleBtn" aria-label="Відкрити чат деканату">
      <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>
    </button>

    <div class="dean-window" id="chatWindow">
      <div class="dean-header">
        <div class="dean-header-info">
          <div class="dean-status-dot"></div>
          <div>
            <p class="dean-title">Віртуальний Деканат</p>
            <p class="dean-subtitle">Чернівецький національний університет</p>
          </div>
        </div>
      </div>

      <div class="dean-group-select">
        <span>Твоя академ. група:</span>
        <input type="text" id="groupInput" placeholder="напр. 301-Б" />
      </div>

      <div class="dean-messages" id="messagesList">
        <div class="msg msg-bot">Вітаю! Я віртуальний помічник факультету. Чим можу допомогти з розкладом чи регламентом?</div>
      </div>

      <div class="quick-chips">
        <button class="chip" data-query="Яка зараз пара?">Яка зараз пара?</button>
        <button class="chip" data-query="Розклад на завтра">Розклад на завтра</button>
        <button class="chip" data-query="Як замовити довідку?">Замовити довідку</button>
        <button class="chip" data-query="Прийомні години декана">Графік декана</button>
      </div>

      <div class="dean-input-area">
        <input type="text" id="userInput" placeholder="Напишіть запитання..." />
        <button class="dean-send-btn" id="sendBtn">Надіслати</button>
      </div>
    </div>
  `;

  shadow.innerHTML = template;

  // Логіка інтерфейсу
  const toggleBtn = shadow.getElementById('toggleBtn');
  const chatWindow = shadow.getElementById('chatWindow');
  const messagesList = shadow.getElementById('messagesList');
  const userInput = shadow.getElementById('userInput');
  const sendBtn = shadow.getElementById('sendBtn');
  const groupInput = shadow.getElementById('groupInput');

  // Зберігаємо групу в localStorage браузера
  groupInput.value = localStorage.getItem('dean_student_group') || '';
  groupInput.addEventListener('input', (e) => {
    localStorage.setItem('dean_student_group', e.target.value.trim());
  });

  toggleBtn.onclick = () => chatWindow.classList.toggle('active');

  function appendMessage(text, role = 'bot') {
    const msg = document.createElement('div');
    msg.className = `msg msg-${role}`;
    msg.textContent = text;
    messagesList.appendChild(msg);
    messagesList.scrollTop = messagesList.scrollHeight;
  }

  async function handleSend(textToSend) {
    const text = textToSend || userInput.value.trim();
    if (!text) return;

    appendMessage(text, 'user');
    if (!textToSend) userInput.value = '';

    const group = groupInput.value.trim();

    try {
      const res = await fetch(`${API_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, group })
      });
      const data = await res.json();
      appendMessage(data.reply || 'Не вдалося сформувати відповідь.');
    } catch (err) {
      appendMessage('Помилка зʼєднання з сервером деканату. Перевірте мережу або зверніться до ауд. 210.');
    }
  }

  sendBtn.onclick = () => handleSend();
  userInput.onkeydown = (e) => { if (e.key === 'Enter') handleSend(); };

  shadow.querySelectorAll('.chip').forEach(chip => {
    chip.onclick = () => handleSend(chip.dataset.query);
  });
})();