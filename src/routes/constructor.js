const express = require("express");
const { db } = require("../db");
const { requireLogin, requirePermission, logAction } = require("../authMiddleware");
const { setFlash } = require("../flash");
const { ah } = require("../asyncHandler");

const router = express.Router();

router.get(
  "/",
  requireLogin,
  requirePermission("constructor"),
  ah(async (req, res) => {
    const journals = await db.all("SELECT * FROM journals WHERE form_type != 'T5' ORDER BY group_name, name");
    res.render("constructor/list", { title: "Конструктор журналов и чек-листов", journals });
  })
);

router.get("/new", requireLogin, requirePermission("constructor"), (req, res) => {
  res.render("constructor/new_journal", { title: "Новый журнал с нуля", error: null });
});

router.post(
  "/new",
  requireLogin,
  requirePermission("constructor"),
  ah(async (req, res) => {
    const { name, group_name, form_type, periodicity, role_fill, role_verify } = req.body;
    if (!name || !group_name || !form_type) {
      return res.status(400).render("constructor/new_journal", { title: "Новый журнал с нуля", error: "Заполните название, группу и тип формы" });
    }
    const info = await db.run(
      `INSERT INTO journals (name, group_name, form_type, periodicity, role_fill, role_verify, active) VALUES (?, ?, ?, ?, ?, ?, 1) RETURNING id`,
      [name.trim(), group_name.trim(), form_type, periodicity || "", role_fill || "", role_verify || ""]
    );
    await db.run("INSERT INTO schema_versions (journal_id, fields_json, created_by) VALUES (?, ?, ?)", [
      info.lastInsertId,
      JSON.stringify([]),
      req.user.id,
    ]);
    await logAction(req.user.id, "create", "journal", info.lastInsertId);
    setFlash(req, "success", "Журнал создан — теперь добавьте поля");
    res.redirect(`/constructor/${info.lastInsertId}`);
  })
);

router.get(
  "/:id",
  requireLogin,
  requirePermission("constructor"),
  ah(async (req, res) => {
    const journal = await db.get("SELECT * FROM journals WHERE id = ?", [req.params.id]);
    if (!journal) return res.status(404).render("error", { title: "Не найдено", message: "Журнал не найден" });
    const schema = await db.get("SELECT * FROM schema_versions WHERE journal_id = ? ORDER BY id DESC LIMIT 1", [journal.id]);
    const versions = await db.all("SELECT id, effective_from FROM schema_versions WHERE journal_id = ? ORDER BY id DESC", [journal.id]);
    res.render("constructor/edit", { title: `Конструктор — ${journal.name}`, journal, fields: JSON.parse(schema.fields_json), versions });
  })
);

async function saveNewVersion(journalId, fields, userId) {
  await db.run("INSERT INTO schema_versions (journal_id, fields_json, created_by) VALUES (?, ?, ?)", [
    journalId,
    JSON.stringify(fields),
    userId,
  ]);
}

router.post(
  "/:id/add-field",
  requireLogin,
  requirePermission("constructor"),
  ah(async (req, res) => {
    const journal = await db.get("SELECT * FROM journals WHERE id = ?", [req.params.id]);
    const schema = await db.get("SELECT * FROM schema_versions WHERE journal_id = ? ORDER BY id DESC LIMIT 1", [journal.id]);
    const fields = JSON.parse(schema.fields_json);

    const { label, type, required, unit, norm_min, norm_max, options } = req.body;
    if (!label || !type) return res.redirect(`/constructor/${journal.id}`);

    const code = `f${Date.now()}`;
    const field = { code, label: label.trim(), type, required: required === "on" };
    if (type === "number") {
      field.unit = unit || "";
      field.norm_min = norm_min ? parseFloat(norm_min) : null;
      field.norm_max = norm_max ? parseFloat(norm_max) : null;
    }
    if (type === "select" || type === "checklist_item") {
      field.options = (options || "Да,Нет").split(",").map((s) => s.trim()).filter(Boolean);
    }
    fields.push(field);
    await saveNewVersion(journal.id, fields, req.user.id);
    await logAction(req.user.id, "add_field", "journal", journal.id, null, field);
    setFlash(req, "success", `Поле «${field.label}» добавлено`);
    res.redirect(`/constructor/${journal.id}`);
  })
);

router.post(
  "/:id/remove-field/:code",
  requireLogin,
  requirePermission("constructor"),
  ah(async (req, res) => {
    const journal = await db.get("SELECT * FROM journals WHERE id = ?", [req.params.id]);
    const schema = await db.get("SELECT * FROM schema_versions WHERE journal_id = ? ORDER BY id DESC LIMIT 1", [journal.id]);
    let fields = JSON.parse(schema.fields_json);
    fields = fields.filter((f) => f.code !== req.params.code);
    await saveNewVersion(journal.id, fields, req.user.id);
    await logAction(req.user.id, "remove_field", "journal", journal.id, null, { code: req.params.code });
    setFlash(req, "success", "Поле убрано из формы");
    res.redirect(`/constructor/${journal.id}`);
  })
);

router.post(
  "/:id/move-field/:code/:dir",
  requireLogin,
  requirePermission("constructor"),
  ah(async (req, res) => {
    const journal = await db.get("SELECT * FROM journals WHERE id = ?", [req.params.id]);
    const schema = await db.get("SELECT * FROM schema_versions WHERE journal_id = ? ORDER BY id DESC LIMIT 1", [journal.id]);
    const fields = JSON.parse(schema.fields_json);
    const idx = fields.findIndex((f) => f.code === req.params.code);
    if (idx === -1) return res.redirect(`/constructor/${journal.id}`);
    const swapWith = req.params.dir === "up" ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= fields.length) return res.redirect(`/constructor/${journal.id}`);
    [fields[idx], fields[swapWith]] = [fields[swapWith], fields[idx]];
    await saveNewVersion(journal.id, fields, req.user.id);
    res.redirect(`/constructor/${journal.id}`);
  })
);

router.post(
  "/:id/rename-field/:code",
  requireLogin,
  requirePermission("constructor"),
  ah(async (req, res) => {
    const journal = await db.get("SELECT * FROM journals WHERE id = ?", [req.params.id]);
    const schema = await db.get("SELECT * FROM schema_versions WHERE journal_id = ? ORDER BY id DESC LIMIT 1", [journal.id]);
    const fields = JSON.parse(schema.fields_json);
    const f = fields.find((x) => x.code === req.params.code);
    if (f && req.body.label) f.label = req.body.label.trim();
    await saveNewVersion(journal.id, fields, req.user.id);
    res.redirect(`/constructor/${journal.id}`);
  })
);

module.exports = router;
