// i18n/probe.mjs — общие строки страниц проверки на устройстве (bench.html, coldstart.html, compat.html; FP-23). RU и EN. Страницы читают каталог напрямую
// (`probe_kit.mjs` → `tr`), без реестра расширений. Правила те же, что у остальных каталогов (tests/demo.test.mjs, TST-56): паритет RU/EN, одинаковые плейсхолдеры, ключи с префиксом
// `probe.`, каждый ключ используется кодом страниц, запрещённых формулировок нет. Обещаний времени здесь нет: измерения на устройствах людьми ещё не сделаны, значит нет и обещания.

export default {
  ru: {
    'probe.nav_label': 'Страницы проверки на устройстве',
    'probe.nav_app': 'Приложение',
    'probe.nav_bench': 'Замер пересчёта',
    'probe.nav_cold': 'Холодный старт',
    'probe.nav_compat': 'Совместимость',

    'probe.s_device': 'Устройство и дата',
    'probe.row_date': 'Дата замера',
    'probe.row_ua': 'Строка браузера (userAgent)',
    'probe.row_platform': 'Платформа',
    'probe.row_lang': 'Язык браузера',
    'probe.row_cores': 'Логических процессоров',
    'probe.row_memory': 'Память устройства (по данным браузера)',
    'probe.row_screen': 'Экран, пикселей',
    'probe.row_ratio': 'Плотность пикселей',
    'probe.row_secure': 'Защищённый контекст (HTTPS или localhost)',
    'probe.row_online': 'Сеть сейчас (navigator.onLine)',
    'probe.memory_val': 'около {gb} ГБ',
    'probe.unknown': 'неизвестно',
    'probe.yes': 'да',
    'probe.no': 'нет',
    'probe.device_note': 'Строка браузера показана только на экране и в копируемом тексте: страница её никуда не отправляет.',

    'probe.s_copy': 'Скопировать результат',
    'probe.out_label': 'Текст для вставки (поле только для чтения)',
    'probe.copy': 'Скопировать результат',
    'probe.copied': 'Скопировано в буфер обмена.',
    'probe.copy_manual': 'Буфер обмена недоступен: текст в поле выделен, его можно скопировать вручную.',

    'probe.disclaimer': 'Расчёт по введённым данным и правилам, не консультация. Цифры — гипотезы-бюджеты (ADR-014), а не обещания продукту; публикуется только измеренное, с n, датой и устройством. Страница ничего не измеряет, пока вы не нажмёте кнопку.',
  },
  en: {
    'probe.nav_label': 'Device check pages',
    'probe.nav_app': 'App',
    'probe.nav_bench': 'Recompute benchmark',
    'probe.nav_cold': 'Cold start',
    'probe.nav_compat': 'Compatibility',

    'probe.s_device': 'Device and date',
    'probe.row_date': 'Measurement date',
    'probe.row_ua': 'Browser string (userAgent)',
    'probe.row_platform': 'Platform',
    'probe.row_lang': 'Browser language',
    'probe.row_cores': 'Logical processors',
    'probe.row_memory': 'Device memory (as reported by the browser)',
    'probe.row_screen': 'Screen, pixels',
    'probe.row_ratio': 'Pixel density',
    'probe.row_secure': 'Secure context (HTTPS or localhost)',
    'probe.row_online': 'Network now (navigator.onLine)',
    'probe.memory_val': 'about {gb} GB',
    'probe.unknown': 'unknown',
    'probe.yes': 'yes',
    'probe.no': 'no',
    'probe.device_note': 'The browser string is shown only on screen and in the copied text: the page does not send it anywhere.',

    'probe.s_copy': 'Copy the result',
    'probe.out_label': 'Text to paste (read-only field)',
    'probe.copy': 'Copy result',
    'probe.copied': 'Copied to the clipboard.',
    'probe.copy_manual': 'The clipboard is not available: the text in the field is selected and can be copied by hand.',

    'probe.disclaimer': 'A calculation from the data and rules you enter, not advice. The figures are budget hypotheses (ADR-014), not promises to the product; only what was measured is published, with n, date and device. The page measures nothing until you press the button.',
  },
};
