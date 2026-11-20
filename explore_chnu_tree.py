import json
import re
import time
import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin

DEPARTMENT_STAFF_URLS = [
    ("Кафедра радіотехніки та інформаційної безпеки", "http://radiotech.chnu.edu.ua/staff/"),
    ("Кафедра кореляційної оптики", "http://corropt.chnu.edu.ua/pro-kafedru/pratsivnyky/"),
    ("Кафедра поліграфічних, мультимедійних та оптичних технологій", "https://cpmot.chnu.edu.ua/pratsivnyky/"),
    ("Кафедра електроніки і енергетики", "https://energy.chnu.edu.ua/pro-kafedru/spivrobitnyky/"),
    ("Кафедра комп'ютерних наук", "https://kkn.chnu.edu.ua/"),
    ("Кафедра комп'ютерних систем та мереж", "https://csn.chnu.edu.ua/employees"),
    ("Кафедра математичних проблем управління і кібернетики", "https://mpuik.chnu.edu.ua/pro-nas/spivrobitnyky/"),
    ("Кафедра програмного забезпечення комп’ютерних систем", "https://pzks.chnu.edu.ua/pro-nas/spivrobitnyky-kafedry/"),
    ("Кафедра інформаційних технологій та комп’ютерної фізики", "https://itcp.chnu.edu.ua/pro-kafedru/spivrobitnyky/"),
    ("Кафедра професійної та технологічної освіти і загальної фізики", "https://generalp.chnu.edu.ua/pro-kafedru/spivrobitnyky/"),
    ("Кафедра термоелектрики та медичної фізики", "https://termo.chnu.edu.ua/pro-nashu-kafedru/spivrobitnyky/"),
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) CHNU-Student-Assistant/1.0"
}

# Регулярка для українського ПІБ (Прізвище Ім'я По-батькові)
PIB_PATTERN = re.compile(
    r"\b([А-ЯІЇЄҐ][а-яіїєґ'’\-]+)\s+([А-ЯІЇЄҐ][а-яіїєґ'’\-]+)\s+([А-ЯІЇЄҐ][а-яіїєґ'’\-]+(?:ич|івна|ївна|ович|йович|ьович))\b"
)

def parse_department(dept_name, url):
    res = requests.get(url, headers=HEADERS, timeout=15)
    res.raise_for_status()
    soup = BeautifulSoup(res.text, "html.parser")

    # Прибираємо навігацію та футер, щоб не зачепити зайві імена
    for tag in soup(["nav", "header", "footer", "script", "style"]):
        tag.decompose()

    teachers_found = {}
    # Шукаємо в заголовках, картках, параграфах та комірках таблиць
    for el in soup.find_all(["h2", "h3", "h4", "h5", "strong", "b", "td", "p", "li", "a"]):
        text = el.get_text(" ", strip=True)
        match = PIB_PATTERN.search(text)
        if not match:
            continue

        last, first, patronymic = match.groups()
        full_name = f"{last} {first} {patronymic}"
        short_key = f"{last} {first[0]}.{patronymic[0]}."

        # Намагаємося витягнути опис/посаду поруч із ПІБ
        parent_text = el.parent.get_text(" ", strip=True) if el.parent else text
        bio_snippet = parent_text[:350] if len(parent_text) > len(full_name) else text

        # Якщо у викладача є власна сторінка-посилання
        person_url = url
        a_tag = el if el.name == "a" else el.find("a", href=True)
        if a_tag and a_tag.get("href"):
            person_url = urljoin(url, a_tag["href"])

        if short_key not in teachers_found:
            teachers_found[short_key] = {
                "fullName": full_name,
                "department": dept_name,
                "info": bio_snippet,
                "source_url": person_url,
            }

    return teachers_found

all_teachers = {}

for dept_name, url in DEPARTMENT_STAFF_URLS:
    print(f"🔎 Скануємо: {dept_name} -> {url}")
    try:
        found = parse_department(dept_name, url)
        print(f"   ✅ Знайдено викладачів: {len(found)}")
        all_teachers.update(found)
    except Exception as e:
        print(f"   ⚠️ Помилка: {e}")
    time.sleep(0.8)

# Зберігаємо повну базу викладачів інституту в окремий JSON
with open("teachers_directory.json", "w", encoding="utf-8") as f:
    json.dump(all_teachers, f, ensure_ascii=False, indent=2)

print(f"\n🎉 Готово! Зібрано {len(all_teachers)} викладачів з усього інституту у файл teachers_directory.json")