const { Pool, types } = require("pg");

// По умолчанию узел `pg` парсит timestamp-колонки в объект JS Date.
// Оставляем их как есть строкой (как было в SQLite-версии), чтобы не
// переписывать форматирование дат во вьюхах и в scheduler.js.
types.setTypeParser(1114, (val) => val); // timestamp without time zone
types.setTypeParser(1184, (val) => val); // timestamp with time zone

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgres://mersi:mersi@localhost:5432/mersi_ism",
});

pool.on("error", (err) => {
  console.error("Неожиданная ошибка простаивающего клиента PostgreSQL", err);
});

// ---------------------------------------------------------------------
// Хелперы запросов. Весь SQL в проекте написан с плейсхолдерами "?" —
// convertPlaceholders переводит их в позиционные $1,$2,... для pg.
// ---------------------------------------------------------------------
function convertPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function makeExecutor(queryFn) {
  return {
    async all(sql, params = []) {
      const res = await queryFn(convertPlaceholders(sql), params);
      return res.rows;
    },
    async get(sql, params = []) {
      const res = await queryFn(convertPlaceholders(sql), params);
      return res.rows[0];
    },
    // run — для INSERT/UPDATE/DELETE. Если INSERT содержит "RETURNING id",
    // результат будет доступен как .lastInsertId.
    async run(sql, params = []) {
      const res = await queryFn(convertPlaceholders(sql), params);
      return {
        rowCount: res.rowCount,
        rows: res.rows,
        lastInsertId: res.rows && res.rows[0] ? res.rows[0].id : undefined,
      };
    },
    async exec(sql) {
      await queryFn(sql);
    },
  };
}

const db = makeExecutor((text, params) => pool.query(text, params));

// Транзакция: withTransaction(async (tx) => { await tx.run(...); ... })
async function withTransaction(fn) {
  const client = await pool.connect();
  const tx = makeExecutor((text, params) => client.query(text, params));
  try {
    await client.query("BEGIN");
    const result = await fn(tx);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------
// Схема — повторяет раздел 2 «Модель данных» технической спецификации v6.0
// ---------------------------------------------------------------------
async function initSchema() {
  await pool.query(`
CREATE TABLE IF NOT EXISTS roles (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  login TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role_code TEXT NOT NULL REFERENCES roles(code),
  department TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','blocked'))
);

CREATE TABLE IF NOT EXISTS standards (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS map_points (
  id SERIAL PRIMARY KEY,
  standard_id INTEGER NOT NULL REFERENCES standards(id),
  clause TEXT NOT NULL,
  point_type TEXT NOT NULL CHECK(point_type IN ('CCP','OPRP','ISO','other')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS journals (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  group_name TEXT NOT NULL,
  form_type TEXT NOT NULL CHECK(form_type IN ('T1','T2','T3','T4','T5')),
  special_module TEXT,
  periodicity TEXT,
  role_fill TEXT,
  role_verify TEXT,
  map_point_id INTEGER REFERENCES map_points(id),
  active INTEGER NOT NULL DEFAULT 0,
  wave INTEGER
);

CREATE TABLE IF NOT EXISTS schema_versions (
  id SERIAL PRIMARY KEY,
  journal_id INTEGER NOT NULL REFERENCES journals(id),
  effective_from TIMESTAMP NOT NULL DEFAULT NOW(),
  fields_json TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS batches (
  id SERIAL PRIMARY KEY,
  number TEXT UNIQUE NOT NULL,
  product TEXT,
  produced_at TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS batch_links (
  id SERIAL PRIMARY KEY,
  child_batch_id INTEGER NOT NULL REFERENCES batches(id),
  parent_batch_id INTEGER NOT NULL REFERENCES batches(id),
  link_type TEXT
);

CREATE TABLE IF NOT EXISTS records (
  id SERIAL PRIMARY KEY,
  journal_id INTEGER NOT NULL REFERENCES journals(id),
  schema_version_id INTEGER NOT NULL REFERENCES schema_versions(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'saved' CHECK(status IN ('draft','saved','verified')),
  values_json TEXT NOT NULL,
  batch_id INTEGER REFERENCES batches(id),
  deviation INTEGER NOT NULL DEFAULT 0,
  deviation_comment TEXT,
  verified_by INTEGER REFERENCES users(id),
  verified_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS record_history (
  id SERIAL PRIMARY KEY,
  record_id INTEGER NOT NULL REFERENCES records(id),
  changed_by INTEGER NOT NULL REFERENCES users(id),
  changed_at TIMESTAMP NOT NULL DEFAULT NOW(),
  field_code TEXT,
  old_value TEXT,
  new_value TEXT
);

CREATE TABLE IF NOT EXISTS nonconformities (
  id SERIAL PRIMARY KEY,
  description TEXT NOT NULL,
  criticality TEXT NOT NULL CHECK(criticality IN ('critical','normal')),
  record_id INTEGER REFERENCES records(id),
  batch_id INTEGER REFERENCES batches(id),
  status TEXT NOT NULL DEFAULT 'registered' CHECK(status IN ('registered','assigned','in_progress','verified','closed')),
  assignee_id INTEGER REFERENCES users(id),
  due_date TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  closed_by INTEGER REFERENCES users(id),
  closed_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS linked_journals (
  id SERIAL PRIMARY KEY,
  journal_id_a INTEGER NOT NULL REFERENCES journals(id),
  journal_id_b INTEGER NOT NULL REFERENCES journals(id),
  field_mapping_json TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  actor_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  before_json TEXT,
  after_json TEXT,
  at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- какие журналы явно назначены пользователю администратором (раздел "видимость журналов")
CREATE TABLE IF NOT EXISTS user_journals (
  user_id INTEGER NOT NULL REFERENCES users(id),
  journal_id INTEGER NOT NULL REFERENCES journals(id),
  PRIMARY KEY (user_id, journal_id)
);

-- динамические права ролей поверх базовой модели (администратор может создавать роли
-- и включать им доступ к конструктору / карте / управлению аудитами)
CREATE TABLE IF NOT EXISTS role_permissions (
  role_code TEXT NOT NULL REFERENCES roles(code),
  permission TEXT NOT NULL,
  PRIMARY KEY (role_code, permission)
);

-- точка карты может ссылаться не только на журналы, но и на регламентный отчёт
CREATE TABLE IF NOT EXISTS point_reports (
  map_point_id INTEGER NOT NULL REFERENCES map_points(id),
  report_code TEXT NOT NULL,
  PRIMARY KEY (map_point_id, report_code)
);

-- модуль аудита (раздел 4.4) — план/календарь, чек-лист, отчёт, ответ ответственного
CREATE TABLE IF NOT EXISTS audits (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  standard_id INTEGER REFERENCES standards(id),
  map_point_id INTEGER REFERENCES map_points(id),
  planned_date TEXT,
  auditor_id INTEGER REFERENCES users(id),
  responsible_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','completed','sent','responded','closed')),
  response_text TEXT,
  response_by INTEGER REFERENCES users(id),
  response_at TIMESTAMP,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_items (
  id SERIAL PRIMARY KEY,
  audit_id INTEGER NOT NULL REFERENCES audits(id),
  text TEXT NOT NULL,
  result TEXT CHECK(result IN ('compliant','observation','critical')),
  comment TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
-- шаблоны чек-листов — готовые наборы пунктов, донастраиваемые и создаваемые заново
CREATE TABLE IF NOT EXISTS checklist_templates (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  standard_id INTEGER REFERENCES standards(id),
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS checklist_template_items (
  id SERIAL PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES checklist_templates(id),
  text TEXT NOT NULL,
  order_num INTEGER NOT NULL DEFAULT 0
);
`);

  // добавления к более ранней схеме — безопасно выполнять повторно
  await pool.query(`
ALTER TABLE nonconformities ADD COLUMN IF NOT EXISTS audit_item_id INTEGER REFERENCES audit_items(id);
ALTER TABLE nonconformities ADD COLUMN IF NOT EXISTS corrective_action TEXT;
ALTER TABLE nonconformities ADD COLUMN IF NOT EXISTS corrective_action_by INTEGER REFERENCES users(id);
ALTER TABLE nonconformities ADD COLUMN IF NOT EXISTS corrective_action_at TIMESTAMP;
ALTER TABLE audit_items ADD COLUMN IF NOT EXISTS photo_path TEXT;
ALTER TABLE audit_items ADD COLUMN IF NOT EXISTS template_item_id INTEGER REFERENCES checklist_template_items(id);
`);
}

module.exports = { pool, db, withTransaction, initSchema };
