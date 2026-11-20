import json
from collections import Counter

with open("schedule_2026.json", "r", encoding="utf-8") as f:
    data = json.load(f)

teachers = [item.get("teacher", "").strip() for item in data if item.get("teacher")]
counts = Counter(teachers)

print(f"Усього пар у базі: {len(data)}")
print(f"Унікальних записів викладачів: {len(counts)}\n")

# 1. Пошук підозрілих прізвищ (різні ініціали, пробіли, капс або схожі корені)
sorted_teachers = sorted(counts.keys())
print("--- ПЕРЕВІРКА НА ДУБЛІКАТИ ТА ОДРУКІВКИ ---")
for i in range(len(sorted_teachers) - 1):
    t1, t2 = sorted_teachers[i], sorted_teachers[i + 1]
    # Якщо перші 5 літер однакові — це майже точно одна людина, записана по-різному
    if t1[:5].lower() == t2[:5].lower():
        print(f"⚠️ Схожі записи: '{t1}' ({counts[t1]} пар)  <--->  '{t2}' ({counts[t2]} пар)")

# 2. Пошук пар без викладача або без аудиторії
missing_teacher = [x for x in data if not x.get("teacher", "").strip()]
print(f"\n❗ Пар без вказаного викладача: {len(missing_teacher)}")

# 3. Збереження чистого списку всіх викладачів у текстовий файл для швидкого перегляду очима
with open("teachers_audit_list.txt", "w", encoding="utf-8") as out:
    for t in sorted_teachers:
        out.write(f"{t} — {counts[t]} пар\n")

print("✅ Повний список збережено у файл teachers_audit_list.txt")