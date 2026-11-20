import * as cheerio from 'cheerio';

const ROOT_URL = 'https://ptcsi.chnu.edu.ua/';
const KAFEDRY_URL = 'https://ptcsi.chnu.edu.ua/pro-instytut/kafedry/';

const DEPARTMENT_STAFF_URLS = [
  'http://radiotech.chnu.edu.ua/staff/',
  'http://corropt.chnu.edu.ua/pro-kafedru/pratsivnyky/',
  'https://cpmot.chnu.edu.ua/pratsivnyky/',
  'https://energy.chnu.edu.ua/pro-kafedru/spivrobitnyky/',
  'https://kkn.chnu.edu.ua/',
  'https://csn.chnu.edu.ua/employees',
  'https://mpuik.chnu.edu.ua/pro-nas/spivrobitnyky/',
  'https://pzks.chnu.edu.ua/pro-nas/spivrobitnyky-kafedry/',
  'https://itcp.chnu.edu.ua/pro-kafedru/spivrobitnyky/',
  'https://generalp.chnu.edu.ua/pro-kafedru/spivrobitnyky/',
  'https://termo.chnu.edu.ua/pro-nashu-kafedru/spivrobitnyky/',
];

// Короткий HTTP-кеш у пам'яті (10 хв), щоб не робити десятки запитів щосекунди
const pageCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

async function fetchHtml(url) {
  const cached = pageCache.get(url);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.html;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) CHNU-LiveNavigator/1.0',
      },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const html = await res.text();
    pageCache.set(url, { html, ts: Date.now() });
    return html;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Живий HTTP-обхід дерева сайту ЧНУ для пошуку актуальної інформації про викладача
 */
export async function fetchLiveTeacherFromSite(surnameStem) {
  if (!surnameStem || surnameStem.length < 3) return null;

  const visitedTrail = [ROOT_URL, KAFEDRY_URL];

  // Паралельно опитуємо актуальні HTTP-гілки кафедр та сторінку керівництва
  const urlsToScan = [
    'https://ptcsi.chnu.edu.ua/pro-instytut/kerivnytstvo/',
    'https://ptcsi.chnu.edu.ua/pro-instytut/',
    ...DEPARTMENT_STAFF_URLS,
  ];

  const results = await Promise.all(
    urlsToScan.map(async (url) => {
      const html = await fetchHtml(url);
      if (!html) return null;

      const $ = cheerio.load(html);
      $('nav, header, footer, script, style').remove();

      const bodyText = $('body').text().replace(/\s+/g, ' ');
      if (!bodyText.toLowerCase().includes(surnameStem.toLowerCase())) {
        return null;
      }

      // Шукаємо персональне посилання на сторінку викладача всередині сторінки кафедри
      let personalUrl = null;
      $('a[href]').each((_, el) => {
        const linkText = $(el).text().trim();
        const href = $(el).attr('href');
        if (href && linkText.toLowerCase().includes(surnameStem.toLowerCase())) {
          try {
            personalUrl = new URL(href, url).toString();
          } catch {}
        }
      });

      // Якщо є персональна сторінка викладача — провалюємося на ще один рівень HTTP-дерева глибше
      let targetUrl = url;
      let targetHtml = html;
      if (personalUrl && personalUrl !== url) {
        const deepHtml = await fetchHtml(personalUrl);
        if (deepHtml) {
          targetUrl = personalUrl;
          targetHtml = deepHtml;
        }
      }

      const $target = cheerio.load(targetHtml);
      $target('nav, header, footer, script, style').remove();
      const cleanText = $target('main, article, .entry-content, .content, body')
        .first()
        .text()
        .replace(/\s+/g, ' ')
        .trim();

      // Вирізаємо контекст навколо знайденого прізвища (до 1200 символів актуального тексту з сайту)
      const idx = cleanText.toLowerCase().indexOf(surnameStem.toLowerCase());
      const start = Math.max(0, idx - 150);
      const snippet = idx !== -1 ? cleanText.slice(start, start + 1200) : cleanText.slice(0, 1200);

      return {
        sourceUrl: targetUrl,
        httpTrail: [...visitedTrail, url, ...(targetUrl !== url ? [targetUrl] : [])],
        liveText: snippet,
      };
    })
  );

  const hits = results.filter(Boolean);
  if (hits.length === 0) return null;

  // Пріоритет віддаємо глибшій персональній сторінці, якщо вона знайшлася
  hits.sort((a, b) => b.httpTrail.length - a.httpTrail.length);
  return hits[0];
}