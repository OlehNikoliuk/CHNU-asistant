import json
import re

with open("schedule_2026.json", "r", encoding="utf-8") as f:
    data = json.load(f)

TYPO_FIXES = {
    "Максимик П.П.": "Максимяк П.П.",
    "Сорокатий М.О.": "Сороковий М.О.",
    "Рождественська М.Г.": "Рождествєнська М.Г.",
}

def clean_teacher_name(raw):
    # Прибираємо наукові ступені/посади, щоб викладач не дублювався
    s = re.sub(r'\b(ас\.|доц\.|проф\.|ст\.викл\.|викл\.)\s*', '', raw, flags=re.IGNORECASE).strip()
    # Додаємо пробіл між прізвищем та ініціалами ("БурковецьД.М." -> "Бурковець Д.М.")
    s = re.sub(r'([а-яіїєґ])([А-ЯІЇЄҐ]\.)', r'\1 \2', s)
    s = re.sub(r'\s+', ' ', s).strip()

    # Універсальна заміна будь-яких ініціалів Шпатаря на П.М.
    if s.lower().startswith("шпатар"):
        return "Шпатар П.М."

    return TYPO_FIXES.get(s, s)

cleaned_data = []
for item in data:
    raw_t = item.get("teacher", "")
    parts = [p.strip() for p in raw_t.split("/") if p.strip()]
    clean_teachers = list(dict.fromkeys(clean_teacher_name(p) for p in parts))

    new_item = dict(item)
    new_item["teachers_list"] = clean_teachers
    new_item["teacher"] = " / ".join(clean_teachers)
    cleaned_data.append(new_item)

# 1. Оновлюємо основний JSON для Node.js асистента (server.js)
with open("schedule_2026.json", "w", encoding="utf-8") as out_json:
    json.dump(cleaned_data, out_json, ensure_ascii=False, indent=2)

# 2. Оновлюємо автономний JS для сторінки розкладу (schedule.html / GitHub Pages)
with open("public/schedule_data.js", "w", encoding="utf-8") as out_js:
    out_js.write("window.SCHEDULE_DATA = ")
    json.dump(cleaned_data, out_js, ensure_ascii=False, indent=2)
    out_js.write(";\n")

unique_clean = sorted({t for item in cleaned_data for t in item["teachers_list"]})
print(f"✅ Оновлено schedule_2026.json та public/schedule_data.js")
print(f"📊 Унікальних чистих викладачів: {len(unique_clean)}")