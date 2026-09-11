const express = require("express");
const path = require("path");
const { db, withTransaction } = require("../db");
const { requireLogin, logAction } = require("../authMiddleware");
const { setFlash } = require("../flash");
const { ah } = require("../asyncHandler");
const { upload } = require("../uploads");

const router = express.Router();

async function getActiveSchema(journalId) {
  return db.get("SELECT * FROM schema_versions WHERE journal_id = ? ORDER BY id DESC LIMIT 1", [journalId]);
}

async function findOrCreateBatch(number) {
  if (!number) return null;
  const n = number.trim();
  if (!n) return null;
  let b = await db.get("SELECT * FROM batches WHERE number = ?", [n]);
  if (!b) {
    const info = await db.run("INSERT INTO batches (number, status) VALUES (?, 'active') RETURNING id", [n]);
    b = { id: info.lastInsertId, number: n };
  }
  return b;
}

// ---- новая запись ----
router.get(
  "/:journalId/new",
  requireLogin,
  ah(async (req, res) => {
    const journal = await db.get("SELECT * FROM journals WHERE id = ?", [req.params.journalId]);
    if (!journal || journal.form_type === "T5") return res.redirect("/journals");
    const schema = await getActiveSchema(journal.id);
    const lastRecord = await db.get("SELECT created_at FROM records WHERE journal_id = ? ORDER BY created_at DESC LIMIT 1", [journal.id]);
    res.render("journals/record_form", {
      title: `Новая запись — ${journal.name}`,
      journal,
      fields: JSON.parse(schema.fields_json),
      values: {},
      errors: null,
      lastRecord,
    });
  })
);

router.post(
  "/:journalId",
  requireLogin,
  upload.any(),
  ah(async (req, res) => {
    const journal = await db.get("SELECT * FROM journals WHERE id = ?", [req.params.journalId]);
    if (!journal) return res.status(404).render("error", { title: "Не найдено", message: "Журнал не найден" });
    const schema = await getActiveSchema(journal.id);
    const fields = JSON.parse(schema.fields_json);

    const values = {};
    const errors = [];
    let deviation = 0;
    const filesByField = {};
    (req.files || []).forEach((f) => (filesByField[f.fieldname] = f));

    fields.forEach((f) => {
      const raw = req.body[f.code];

      if (f.type === "photo") {
        const file = filesByField[f.code];
        if (file) {
          values[f.code] = file.filename;
        } else {
          values[f.code] = "";
          if (f.required) errors.push(`Поле «${f.label}» обязательно — прикрепите фото/файл`);
        }
        return;
      }

      if (f.type === "indicator_table") {
        const rows = (raw || "")
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => l.split(";").map((c) => c.trim()));
        values[f.code] = rows;
        if (f.required && rows.length === 0) errors.push(`Поле «${f.label}» обязательно`);
      } else {
        values[f.code] = raw === undefined ? "" : raw;
        if (f.required && !String(raw || "").trim()) errors.push(`Поле «${f.label}» обязательно`);
      }

      if (f.type === "number" && raw !== undefined && raw !== "") {
        const num = parseFloat(raw);
        const min = f.norm_min !== null && f.norm_min !== undefined ? parseFloat(f.norm_min) : null;
        const max = f.norm_max !== null && f.norm_max !== undefined ? parseFloat(f.norm_max) : null;
        if ((min !== null && num < min) || (max !== null && num > max)) deviation = 1;
      }
      if (f.type === "checklist_item" && raw === "Нет") deviation = 1;
    });

    const comment = (req.body.comment || values.comment || "").trim();
    if (deviation && !comment) {
      errors.push("Значение вне нормы / есть замечания — заполните комментарий-причину");
    }

    if (errors.length) {
      const lastRecord = await db.get("SELECT created_at FROM records WHERE journal_id = ? ORDER BY created_at DESC LIMIT 1", [journal.id]);
      return res.status(400).render("journals/record_form", {
        title: `Новая запись — ${journal.name}`,
        journal,
        fields,
        values: req.body,
        errors,
        lastRecord,
      });
    }

    const batch = await findOrCreateBatch(req.body.batch_number);

    const info = await db.run(
      `INSERT INTO records (journal_id, schema_version_id, author_id, status, values_json, batch_id, deviation, deviation_comment)
       VALUES (?, ?, ?, 'saved', ?, ?, ?, ?) RETURNING id`,
      [journal.id, schema.id, req.user.id, JSON.stringify(values), batch ? batch.id : null, deviation, deviation ? comment : null]
    );
    const recordId = info.lastInsertId;

    await logAction(req.user.id, "create", "record", recordId, null, values);
    setFlash(req, deviation ? "error" : "success", deviation ? "Запись сохранена — зафиксировано отклонение" : "Запись сохранена");

    const linked = await db.all("SELECT * FROM linked_journals WHERE journal_id_a = ? OR journal_id_b = ?", [journal.id, journal.id]);
    if (linked.length) {
      const otherId = linked[0].journal_id_a === journal.id ? linked[0].journal_id_b : linked[0].journal_id_a;
      return res.redirect(`/records/${recordId}?suggestJournal=${otherId}`);
    }

    // быстрое добавление из списка журнала — возвращаемся туда же, а не на карточку записи,
    // чтобы можно было сразу ввести следующую запись (раздел «ведение журнала»)
    if (req.body.quick === "1") {
      const params = new URLSearchParams();
      if (req.body.return_view) params.set("view", req.body.return_view);
      if (req.body.return_q) params.set("q", req.body.return_q);
      if (req.body.return_from) params.set("from", req.body.return_from);
      if (req.body.return_to_date) params.set("to", req.body.return_to_date);
      const qs = params.toString();
      return res.redirect(`/journals/${journal.id}${qs ? "?" + qs : ""}#quick-added`);
    }

    // «сохранить и создать ещё» — сразу назад на пустую форму этого же журнала
    if (req.body.again === "1") {
      return res.redirect(`/records/${journal.id}/new`);
    }

    res.redirect(`/records/${recordId}`);
  })
);

// ---- просмотр записи ----
router.get(
  "/:id",
  requireLogin,
  ah(async (req, res) => {
    const record = await db.get(
      `SELECT r.*, u.full_name AS author_name, v.full_name AS verifier_name
       FROM records r LEFT JOIN users u ON u.id = r.author_id LEFT JOIN users v ON v.id = r.verified_by
       WHERE r.id = ?`,
      [req.params.id]
    );
    if (!record) return res.status(404).render("error", { title: "Не найдено", message: "Запись не найдена" });
    const journal = await db.get("SELECT * FROM journals WHERE id = ?", [record.journal_id]);
    const schema = await db.get("SELECT * FROM schema_versions WHERE id = ?", [record.schema_version_id]);
    const fields = JSON.parse(schema.fields_json);
    const values = JSON.parse(record.values_json);
    const history = await db.all(
      `SELECT h.*, u.full_name AS changed_by_name FROM record_history h LEFT JOIN users u ON u.id = h.changed_by
       WHERE h.record_id = ? ORDER BY h.changed_at DESC`,
      [record.id]
    );

    let suggestJournal = null;
    if (req.query.suggestJournal) {
      suggestJournal = await db.get("SELECT * FROM journals WHERE id = ?", [req.query.suggestJournal]);
    }

    const nc = await db.all("SELECT * FROM nonconformities WHERE record_id = ?", [record.id]);

    res.render("journals/record_view", {
      title: `Запись — ${journal.name}`,
      journal,
      fields,
      values,
      record,
      history,
      suggestJournal,
      nc,
      canVerify: record.status === "saved" && ["quality", "shift_lead", "director"].includes(req.user.role_code),
      canEdit: record.status !== "draft" && req.user.role_code === "quality",
    });
  })
);

// ---- проверка записи ----
router.post(
  "/:id/verify",
  requireLogin,
  ah(async (req, res) => {
    const record = await db.get("SELECT * FROM records WHERE id = ?", [req.params.id]);
    if (!record) return res.status(404).render("error", { title: "Не найдено", message: "Запись не найдена" });
    if (!["quality", "shift_lead", "director"].includes(req.user.role_code)) {
      return res.status(403).render("error", { title: "Доступ запрещён", message: "Проверка записи недоступна для вашей роли." });
    }
    await db.run("UPDATE records SET status = 'verified', verified_by = ?, verified_at = NOW() WHERE id = ?", [req.user.id, record.id]);
    await logAction(req.user.id, "verify", "record", record.id);
    setFlash(req, "success", "Запись отмечена как проверенная");
    res.redirect(`/records/${record.id}`);
  })
);

// ---- исправление сохранённой/проверенной записи (с историей) ----
router.post(
  "/:id/edit",
  requireLogin,
  ah(async (req, res) => {
    if (req.user.role_code !== "quality") {
      return res.status(403).render("error", { title: "Доступ запрещён", message: "Исправление записей доступно только специалисту по качеству." });
    }
    const record = await db.get("SELECT * FROM records WHERE id = ?", [req.params.id]);
    if (!record) return res.status(404).render("error", { title: "Не найдено", message: "Запись не найдена" });
    const schema = await db.get("SELECT * FROM schema_versions WHERE id = ?", [record.schema_version_id]);
    const fields = JSON.parse(schema.fields_json);
    const oldValues = JSON.parse(record.values_json);
    const newValues = { ...oldValues };

    await withTransaction(async (tx) => {
      for (const f of fields) {
        if (f.type === "indicator_table" || f.type === "photo") continue;
        const newVal = req.body[f.code];
        if (newVal === undefined) continue;
        if (String(oldValues[f.code] || "") !== String(newVal)) {
          await tx.run(`INSERT INTO record_history (record_id, changed_by, field_code, old_value, new_value) VALUES (?, ?, ?, ?, ?)`, [
            record.id,
            req.user.id,
            f.code,
            String(oldValues[f.code] || ""),
            String(newVal),
          ]);
          newValues[f.code] = newVal;
        }
      }
      await tx.run("UPDATE records SET values_json = ? WHERE id = ?", [JSON.stringify(newValues), record.id]);
    });

    await logAction(req.user.id, "edit", "record", record.id, oldValues, newValues);
    setFlash(req, "success", "Исправление сохранено, история изменений обновлена");
    res.redirect(`/records/${record.id}`);
  })
);

module.exports = router;
