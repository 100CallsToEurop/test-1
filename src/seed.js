const bcrypt = require("bcryptjs");
const { db, withTransaction, initSchema } = require("./db");
const { groups } = require("./seedData");

const ROLES = [
  ["operator", "Оператор"],
  ["quality", "Специалист по качеству (ИСМ/ОТК)"],
  ["shift_lead", "Мастер смены / начальник цеха"],
  ["storekeeper", "Кладовщик"],
  ["auditor", "Внутренний аудитор"],
  ["director", "Руководитель / директор по качеству"],
  ["admin", "Администратор"],
];

const DEMO_USERS = [
  ["Иванов Иван (Оператор)", "operator", "operator", "Цех №1"],
  ["Смирнова Анна (Специалист качества)", "quality", "quality", "ОТК"],
  ["Петров Пётр (Мастер смены)", "shift_lead", "shift_lead", "Цех №1"],
  ["Кузнецова Ольга (Кладовщик)", "storekeeper", "storekeeper", "Склад"],
  ["Соколов Сергей (Внутренний аудитор)", "auditor", "auditor", "СМК"],
  ["Директорова Мария (Директор по качеству)", "director", "director", "Дирекция"],
  ["Администраторов Артём (Администратор)", "admin", "admin", "ИТ"],
];

const STANDARDS = [
  "ТР ТС 021/2011",
  "ГОСТ Р ИСО 22000",
  "ГОСТ Р 51705.1-2024",
  "FSSC 22000",
  "BRC",
  "IFS",
  "GMP+",
  "ISO 14001",
  "ISO 45001",
  "SQF 2000",
];

// какие журналы (по ключевым словам в поле «заполняет»/«проверяет») видны каждой
// демо-роли по умолчанию — админ задаёт точечные исключения потом через UI
const ROLE_VISIBILITY_KEYWORDS = {
  operator: ["Оператор"],
  shift_lead: ["Мастер смены", "Начальник цеха"],
  storekeeper: ["Кладовщик", "Начальник склада"],
};

// права ролей по умолчанию поверх базовой модели (раздел «Роли и права» в админке)
const DEFAULT_PERMISSIONS = [
  ["quality", "constructor"],
  ["quality", "map_edit"],
  ["quality", "audit_manage"],
  ["auditor", "audit_manage"],
];

function looksDate(label) {
  return /дата/i.test(label);
}
function makeCode(label, idx) {
  const translit = String(label)
    .toLowerCase()
    .replace(/[«»"'()]/g, "")
    .replace(/[^a-zA-Zа-яА-ЯёЁ0-9]+/g, "_")
    .slice(0, 24);
  return `f${idx}_${translit || "field"}`;
}

function parseFields(formType, text) {
  if (formType === "T5") return { fields: [], special: text.trim() };

  if (formType === "T1") {
    const first = text.split(";")[0].trim();
    return {
      fields: [
        { code: "value", label: first || "Значение", type: "number", required: true, unit: "", norm_min: null, norm_max: null },
        { code: "comment", label: "Комментарий (при отклонении)", type: "text", required: false },
      ],
      special: null,
    };
  }

  if (formType === "T2") {
    const items = text.split("/").map((s) => s.trim()).filter(Boolean);
    const fields = items.map((label, i) => ({ code: `item_${i + 1}`, label, type: "checklist_item", required: true, options: ["Да", "Нет"] }));
    fields.push({ code: "comment", label: "Комментарий (обязателен при «Нет»)", type: "text", required: false });
    return { fields, special: null };
  }

  if (formType === "T3") {
    const cols = text.split(";").map((s) => s.trim()).filter(Boolean);
    return {
      fields: [
        { code: "indicators", label: "Таблица показателей", type: "indicator_table", required: true, columns: cols.length ? cols : ["показатель", "значение", "норма"] },
        { code: "conclusion", label: "Заключение", type: "select", required: true, options: ["Соответствует", "Не соответствует"] },
      ],
      special: null,
    };
  }

  const parts = text.split(";").map((s) => s.trim()).filter(Boolean);
  const fields = parts.map((label, i) => ({ code: makeCode(label, i + 1), label, type: looksDate(label) ? "date" : "text", required: false }));
  return { fields, special: null };
}

async function run() {
  await initSchema();

  await withTransaction(async (tx) => {
    for (const [c, n] of ROLES) {
      await tx.run("INSERT INTO roles (code, name) VALUES (?, ?) ON CONFLICT (code) DO NOTHING", [c, n]);
    }
  });

  const userCount = (await db.get("SELECT COUNT(*) c FROM users")).c;
  if (Number(userCount) === 0) {
    await withTransaction(async (tx) => {
      for (const [name, login, roleCode, dept] of DEMO_USERS) {
        const hash = bcrypt.hashSync(`${login}123`, 10);
        await tx.run("INSERT INTO users (full_name, login, password_hash, role_code, department) VALUES (?, ?, ?, ?, ?)", [
          name,
          login,
          hash,
          roleCode,
          dept,
        ]);
      }
    });
    console.log(
      "Созданы демо-пользователи. Логин = роль (operator, quality, shift_lead, storekeeper, auditor, director, admin), пароль = логин + '123'."
    );
  }

  await withTransaction(async (tx) => {
    for (const s of STANDARDS) {
      await tx.run("INSERT INTO standards (name) VALUES (?) ON CONFLICT (name) DO NOTHING", [s]);
    }
  });

  const journalCount = (await db.get("SELECT COUNT(*) c FROM journals")).c;
  if (Number(journalCount) === 0) {
    await withTransaction(async (tx) => {
      for (const g of groups) {
        for (const row of g.rows) {
          const [, name, formType, periodicity, roleFill, roleVerify, fieldsText] = row;
          const { fields, special } = parseFields(formType, fieldsText);
          const info = await tx.run(
            `INSERT INTO journals (name, group_name, form_type, special_module, periodicity, role_fill, role_verify, active)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1) RETURNING id`,
            [name, g.group, formType, formType === "T5" ? special : null, periodicity, roleFill, roleVerify]
          );
          await tx.run("INSERT INTO schema_versions (journal_id, fields_json) VALUES (?, ?)", [info.lastInsertId, JSON.stringify(fields)]);
        }
      }
    });
    const total = (await db.get("SELECT COUNT(*) c FROM journals")).c;
    console.log(`Загружена библиотека журналов: ${total} шт.`);
  }

  // права ролей по умолчанию — выполняется при каждом запуске (ON CONFLICT DO NOTHING),
  // так что если администратор их уже поменял через UI, ничего не перезатрётся
  await withTransaction(async (tx) => {
    for (const [role, perm] of DEFAULT_PERMISSIONS) {
      await tx.run("INSERT INTO role_permissions (role_code, permission) VALUES (?, ?) ON CONFLICT (role_code, permission) DO NOTHING", [
        role,
        perm,
      ]);
    }
  });

  // видимость журналов по умолчанию для демо-пользователей (раздел «видимость журналов»);
  // выполняется один раз — дальше это регулирует администратор через /admin/users/:id/journals
  const ujCount = (await db.get("SELECT COUNT(*) c FROM user_journals")).c;
  if (Number(ujCount) === 0) {
    await withTransaction(async (tx) => {
      const journalsAll = await tx.all("SELECT id, role_fill, role_verify FROM journals WHERE form_type != 'T5'");
      for (const [roleCode, keywords] of Object.entries(ROLE_VISIBILITY_KEYWORDS)) {
        const user = await tx.get("SELECT id FROM users WHERE role_code = ?", [roleCode]);
        if (!user) continue;
        const matching = journalsAll.filter((j) => keywords.some((k) => (j.role_fill || "").includes(k) || (j.role_verify || "").includes(k)));
        for (const j of matching) {
          await tx.run("INSERT INTO user_journals (user_id, journal_id) VALUES (?, ?) ON CONFLICT DO NOTHING", [user.id, j.id]);
        }
      }
    });
    console.log("Назначены журналы по умолчанию демо-пользователям (оператор, мастер смены, кладовщик).");
  }

  const mpCount = (await db.get("SELECT COUNT(*) c FROM map_points")).c;
  if (Number(mpCount) === 0) {
    await withTransaction(async (tx) => {
      const std = await tx.get("SELECT id FROM standards WHERE name = ?", ["ГОСТ Р ИСО 22000"]);
      const info = await tx.run("INSERT INTO map_points (standard_id, clause, point_type) VALUES (?, ?, ?) RETURNING id", [
        std.id,
        "п. 8.5.4 Контроль мониторинга и измерений",
        "ISO",
      ]);
      const pointId = info.lastInsertId;
      const inputJ = await tx.get("SELECT id FROM journals WHERE name = ?", ["Входного контроля"]);
      const receiveJ = await tx.get("SELECT id FROM journals WHERE name = ?", ["Приём сырья"]);
      if (inputJ) await tx.run("UPDATE journals SET map_point_id = ? WHERE id = ?", [pointId, inputJ.id]);
      if (receiveJ) await tx.run("UPDATE journals SET map_point_id = ? WHERE id = ?", [pointId, receiveJ.id]);
      if (inputJ && receiveJ) {
        await tx.run("INSERT INTO linked_journals (journal_id_a, journal_id_b, field_mapping_json) VALUES (?, ?, ?)", [
          receiveJ.id,
          inputJ.id,
          JSON.stringify({ note: "дата, партия и автор переносятся автоматически (демо-связка)" }),
        ]);
      }
    });
    console.log("Создана демо точка карты критических точек и связка журналов «Приём сырья» → «Входной контроль».");
  }

  const batchCount = (await db.get("SELECT COUNT(*) c FROM batches")).c;
  if (Number(batchCount) === 0) {
    await withTransaction(async (tx) => {
      const raw = await tx.run("INSERT INTO batches (number, product, produced_at, status) VALUES (?, ?, ?, 'active') RETURNING id", [
        "СЫРЬЁ-2026-0001",
        "Сырьё: молоко цельное",
        "2026-09-08",
      ]);
      const fg = await tx.run("INSERT INTO batches (number, product, produced_at, status) VALUES (?, ?, ?, 'active') RETURNING id", [
        "ГП-2026-0001",
        "Йогурт натуральный 0.5л",
        "2026-09-09",
      ]);
      await tx.run("INSERT INTO batch_links (child_batch_id, parent_batch_id, link_type) VALUES (?, ?, 'production')", [
        fg.lastInsertId,
        raw.lastInsertId,
      ]);
    });
    console.log("Создана демо-цепочка прослеживаемости: СЫРЬЁ-2026-0001 → ГП-2026-0001.");
  }

  const auditCount = (await db.get("SELECT COUNT(*) c FROM audits")).c;
  if (Number(auditCount) === 0) {
    await withTransaction(async (tx) => {
      const auditor = await tx.get("SELECT id FROM users WHERE role_code = 'auditor'");
      const quality = await tx.get("SELECT id FROM users WHERE role_code = 'quality'");
      const director = await tx.get("SELECT id FROM users WHERE role_code = 'director'");
      const std = await tx.get("SELECT id FROM standards WHERE name = ?", ["ГОСТ Р ИСО 22000"]);
      const point = await tx.get("SELECT id FROM map_points WHERE standard_id = ?", [std.id]);
      const info = await tx.run(
        `INSERT INTO audits (title, standard_id, map_point_id, planned_date, auditor_id, responsible_id, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 'planned', ?) RETURNING id`,
        ["Плановый внутренний аудит — контроль мониторинга и измерений", std.id, point ? point.id : null, "2026-09-20", auditor.id, quality.id, director.id]
      );
      console.log(`Создан демо-аудит #${info.lastInsertId}.`);
    });
  }

  const templateCount = (await db.get("SELECT COUNT(*) c FROM checklist_templates")).c;
  if (Number(templateCount) === 0) {
    await withTransaction(async (tx) => {
      const quality = await tx.get("SELECT id FROM users WHERE role_code = 'quality'");
      const stdIso = await tx.get("SELECT id FROM standards WHERE name = ?", ["ГОСТ Р ИСО 22000"]);
      const stdIso45001 = await tx.get("SELECT id FROM standards WHERE name = ?", ["ISO 45001"]);

      const starterTemplates = [
        {
          name: "Пищевая безопасность — обход цеха",
          category: "Пищевая безопасность",
          standard_id: stdIso ? stdIso.id : null,
          items: [
            "Санитарная одежда персонала в порядке",
            "Личная гигиена персонала соблюдается",
            "Контейнеры для сырья/полуфабрикатов/готовой продукции промаркированы",
            "Температурный режим в зоне хранения соблюдается",
            "Следы вредителей отсутствуют",
            "Средства для мытья и дезинфекции рук в наличии и промаркированы",
          ],
        },
        {
          name: "Охрана труда — обход участка",
          category: "Экология и охрана труда",
          standard_id: stdIso45001 ? stdIso45001.id : null,
          items: [
            "СИЗ используются по назначению",
            "Пути эвакуации свободны",
            "Огнетушители на месте и опломбированы",
            "Аптечка укомплектована, сроки годности медикаментов не истекли",
            "Инструктаж по ОТ пройден и задокументирован",
          ],
        },
        {
          name: "Менеджмент качества — внутренний аудит процесса",
          category: "Менеджмент качества и процессы",
          standard_id: stdIso ? stdIso.id : null,
          items: [
            "Документация процесса актуальна",
            "Записи по процессу ведутся своевременно",
            "Ответственный за процесс определён",
            "Показатели результативности процесса отслеживаются",
            "Предыдущие несоответствия по процессу закрыты",
          ],
        },
      ];

      for (const t of starterTemplates) {
        const info = await tx.run("INSERT INTO checklist_templates (name, category, standard_id, created_by) VALUES (?, ?, ?, ?) RETURNING id", [
          t.name,
          t.category,
          t.standard_id,
          quality ? quality.id : null,
        ]);
        let order = 1;
        for (const text of t.items) {
          await tx.run("INSERT INTO checklist_template_items (template_id, text, order_num) VALUES (?, ?, ?)", [
            info.lastInsertId,
            text,
            order++,
          ]);
        }
      }
    });
    console.log("Созданы готовые шаблоны чек-листов (3 шт., донастраиваются и дополняются в разделе «Шаблоны чек-листов»).");
  }
}

if (require.main === module) {
  run()
    .then(() => {
      console.log("Готово.");
      process.exit(0);
    })
    .catch((err) => {
      console.error("Ошибка сидирования:", err);
      process.exit(1);
    });
}

module.exports = { run, parseFields };
