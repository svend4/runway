// start_template.mjs — шаблоны-скелеты для мастера «Старт» (FP-10, REQ-068, IDEA-34, ADR-015).
// Шаблон подсказывает только НАЗВАНИЯ строк (аренда, связь, выплата от клиента…) и частоту. Сумм, ставок (`rate_bp`), налоговых календарей и шаблонов
// стран в нём нет: всё вводит пользователь. У правила в скелете есть срок годности (`ttl_days`) и пустая отметка проверки (`reviewed_at: null`):
// проверка людьми (юридическое ревью REQ-183, вычитка RU/EN) не выполнена и помечена как «ожидает людей» — готовности шаблон не заявляет.
// Зеркало `data/templates/freelancer-skeleton.json`: страница не читает JSON сама (сеть разрешена только приложению, динамический import — только манифесту),
// равенство двух копий проверяет tests/wizard.test.mjs. Модуль чистый: без DOM, часов и сети. Расчёт по введённым данным и правилам, не консультация.

/** Формат файла шаблона. */
export const TEMPLATE_FORMAT = 'runway-template/1';

/** Разрешённые частоты подсказок: ежемесячно, еженедельно, раз в год. */
export const TEMPLATE_FREQS = Object.freeze(['M', 'W', 'Y']);

const deep_freeze = (x) => {
  if (x !== null && typeof x === 'object') for (const v of Object.values(x)) deep_freeze(v);
  return Object.freeze(x);
};

const slot = (id, freq, ru, en) => ({ slot: id, freq, label: { ru, en } });

/** Зеркало `data/templates/freelancer-skeleton.json` (порядок и значения те же). */
export const TEMPLATES = deep_freeze({
  'freelancer-skeleton': {
    format: TEMPLATE_FORMAT,
    template_id: 'freelancer-skeleton',
    kind: 'skeleton',
    title: { ru: 'Фрилансер: скелет без сумм и ставок', en: 'Freelancer: skeleton without amounts or rates' },
    note: {
      ru: 'Скелет подсказывает названия строк. Сумм, ставок, налоговых календарей и шаблонов стран в нём нет: всё вводите вы. Расчёт по введённым данным и правилам, не консультация.',
      en: 'The skeleton only suggests row names. It has no amounts, rates, tax calendars or country templates: you enter everything. Calculated from the data and rules you enter; not advice.',
    },
    policy: 'no_prefilled_amounts_or_rates',
    review: { status: 'awaiting_humans', reviewed_at: null, ttl_days: 365 },
    obligations: [
      slot('rent', 'M', 'Аренда', 'Rent'),
      slot('utilities', 'M', 'Коммунальные услуги', 'Utilities'),
      slot('phone', 'M', 'Связь и интернет', 'Phone and internet'),
      slot('software', 'M', 'Подписки и программы для работы', 'Work software and subscriptions'),
      slot('insurance', 'Y', 'Страховка', 'Insurance'),
    ],
    income: [slot('client_payout', 'M', 'Выплата от клиента', 'Client payout')],
    daily: [slot('everyday', 'W', 'Продукты и повседневное', 'Groceries and everyday spending')],
    tax_rule: {
      kind: 'percent_of_income',
      rate_bp: null,
      ttl_days: 365,
      reviewed_at: null,
      note: {
        ru: 'Ставку и срок проверки правила вводите вы в разделе «Формы данных»; здесь их нет.',
        en: 'You enter the rate and the review term in the data forms; they are not here.',
      },
    },
  },
});

/** Идентификаторы шаблонов. */
export const TEMPLATE_IDS = Object.freeze(Object.keys(TEMPLATES));

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/**
 * Проверка шаблона-скелета (REQ-068): формат, нет чисел в полях сумм и ставок, `rate_bp` пуст, у правила есть срок годности, отметка проверки пуста
 * (проверку людьми шаблон не заявляет), подписи есть на обоих языках.
 * @param {any} t
 * @returns {string[]} описания нарушений (пусто — шаблон в порядке)
 */
export function validate_template(t) {
  const errors = [];
  if (!is_obj(t)) return ['not_object'];
  if (t.format !== TEMPLATE_FORMAT) errors.push('bad_format');
  if (t.kind !== 'skeleton') errors.push('not_skeleton');
  if (typeof t.template_id !== 'string' || !/^[a-z][a-z0-9-]{2,40}$/.test(t.template_id)) errors.push('bad_template_id');
  // числовых сумм и ставок нет нигде: ни по ключу, ни как число в поле с «денежным» именем
  const walk = (x, path) => {
    if (Array.isArray(x)) { x.forEach((v, i) => walk(v, path + '[' + i + ']')); return; }
    if (!is_obj(x)) return;
    for (const [k, v] of Object.entries(x)) {
      const at = path === '' ? k : path + '.' + k;
      if (k === 'rate_bp' && v !== null && v !== undefined) errors.push('prefilled_rate:' + at);
      if (typeof v === 'number' && /amount|minor|rate|bp$|sum|price|balance/i.test(k)) errors.push('prefilled_number:' + at);
      walk(v, at);
    }
  };
  walk(t, '');
  const rv = t.review;
  if (!is_obj(rv) || !Number.isSafeInteger(rv.ttl_days) || rv.ttl_days < 1) errors.push('review_no_ttl');
  if (is_obj(rv) && rv.reviewed_at !== null) errors.push('review_claimed');
  if (is_obj(rv) && rv.status !== 'awaiting_humans') errors.push('review_status');
  const tr = t.tax_rule;
  if (!is_obj(tr) || tr.rate_bp !== null) errors.push('tax_rule_rate');
  if (is_obj(tr) && (!Number.isSafeInteger(tr.ttl_days) || tr.ttl_days < 1)) errors.push('tax_rule_no_ttl');
  if (is_obj(tr) && tr.reviewed_at !== null) errors.push('tax_rule_reviewed');
  for (const part of ['obligations', 'income', 'daily']) {
    if (!Array.isArray(t[part]) || t[part].length === 0) { errors.push('no_' + part); continue; }
    for (const s of t[part]) {
      if (!is_obj(s) || typeof s.slot !== 'string' || !TEMPLATE_FREQS.includes(s.freq)) errors.push('bad_slot:' + part);
      else if (!is_obj(s.label) || typeof s.label.ru !== 'string' || s.label.ru === '' || typeof s.label.en !== 'string' || s.label.en === '') errors.push('no_label:' + s.slot);
    }
  }
  for (const k of ['title', 'note']) if (!is_obj(t[k]) || typeof t[k].ru !== 'string' || typeof t[k].en !== 'string') errors.push('no_text:' + k);
  return errors;
}

/**
 * Подсказки одного раздела шаблона на языке интерфейса: `[{slot, freq, label}]`.
 * @param {string} template_id
 * @param {'obligations'|'income'|'daily'} part
 * @param {'ru'|'en'} lang
 * @returns {{slot: string, freq: string, label: string}[]}
 */
export function template_slots(template_id, part, lang) {
  const t = Object.hasOwn(TEMPLATES, template_id) ? TEMPLATES[template_id] : undefined;
  if (t === undefined || !Array.isArray(t[part])) return [];
  return t[part].map((s) => ({ slot: s.slot, freq: s.freq, label: s.label[lang] ?? s.label.ru }));
}
