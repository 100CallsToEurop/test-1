const express = require("express");
const { db } = require("../db");
const { requireLogin, requirePermission, can, logAction } = require("../authMiddleware");
const { ah } = require("../asyncHandler");

const router = express.Router();
const CAN_EDIT = "audit_manage"; // тот же круг ролей, что управляет аудитами

router.get(
  "/",
  requireLogin,
  ah(async (req, res) => {
    const templates = await db.all(
      `SELECT t.*, s.name AS standard_name, (SELECT COUNT(*) FROM checklist_template_items i WHERE i.template_id = t.id) AS items_count
       FROM checklist_templates t LEFT JOIN standards s ON s.id = t.standard_id
       ORDER BY t.category, t.name`
    );
    const byCategory = {};
    templates.forEach((t) => {
      const cat = t.category || "Без категории";
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(t);
    });
    res.render("checklist_templates/list", { title: "Шаблоны чек-листов", byCategory });
  })
);

router.get(
  "/new",
  requireLogin,
  requirePermission(CAN_EDIT),
  ah(async (req, res) => {
    const standards = await db.all("SELECT * FROM standards ORDER BY name");
    res.render("checklist_templates/new", { title: "Новый шаблон чек-листа", standards, error: null });
  })
);

router.post(
  "/",
  requireLogin,
  requirePermission(CAN_EDIT),
  ah(async (req, res) => {
    const { name, category, standard_id } = req.body;
    if (!name || !name.trim()) {
      const standards = await db.all("SELECT * FROM standards ORDER BY name");
      return res.status(400).render("checklist_templates/new", { title: "Новый шаблон чек-листа", standards, error: "Укажите название шаблона" });
    }
    const info = await db.run("INSERT INTO checklist_templates (name, category, standard_id, created_by) VALUES (?, ?, ?, ?) RETURNING id", [
      name.trim(),
      category || null,
      standard_id || null,
      req.user.id,
    ]);
    await logAction(req.user.id, "create", "checklist_template", info.lastInsertId);
    res.redirect(`/checklist-templates/${info.lastInsertId}`);
  })
);

router.get(
  "/:id",
  requireLogin,
  ah(async (req, res) => {
    const template = await db.get(
      `SELECT t.*, s.name AS standard_name FROM checklist_templates t LEFT JOIN standards s ON s.id = t.standard_id WHERE t.id = ?`,
      [req.params.id]
    );
    if (!template) return res.status(404).render("error", { title: "Не найдено", message: "Шаблон не найден" });
    const items = await db.all("SELECT * FROM checklist_template_items WHERE template_id = ? ORDER BY order_num, id", [template.id]);
    const canEdit = await can(req.user, CAN_EDIT);
    res.render("checklist_templates/edit", { title: template.name, template, items, canEdit });
  })
);

router.post(
  "/:id/items",
  requireLogin,
  requirePermission(CAN_EDIT),
  ah(async (req, res) => {
    const { text } = req.body;
    if (!text || !text.trim()) return res.redirect(`/checklist-templates/${req.params.id}`);
    const maxRow = await db.get("SELECT COALESCE(MAX(order_num), 0) m FROM checklist_template_items WHERE template_id = ?", [req.params.id]);
    await db.run("INSERT INTO checklist_template_items (template_id, text, order_num) VALUES (?, ?, ?)", [
      req.params.id,
      text.trim(),
      Number(maxRow.m) + 1,
    ]);
    res.redirect(`/checklist-templates/${req.params.id}`);
  })
);

router.post(
  "/:id/items/:itemId/remove",
  requireLogin,
  requirePermission(CAN_EDIT),
  ah(async (req, res) => {
    await db.run("DELETE FROM checklist_template_items WHERE id = ? AND template_id = ?", [req.params.itemId, req.params.id]);
    res.redirect(`/checklist-templates/${req.params.id}`);
  })
);

router.post(
  "/:id/items/:itemId/rename",
  requireLogin,
  requirePermission(CAN_EDIT),
  ah(async (req, res) => {
    if (req.body.text) {
      await db.run("UPDATE checklist_template_items SET text = ? WHERE id = ? AND template_id = ?", [
        req.body.text.trim(),
        req.params.itemId,
        req.params.id,
      ]);
    }
    res.redirect(`/checklist-templates/${req.params.id}`);
  })
);

router.post(
  "/:id/items/:itemId/move/:dir",
  requireLogin,
  requirePermission(CAN_EDIT),
  ah(async (req, res) => {
    const items = await db.all("SELECT * FROM checklist_template_items WHERE template_id = ? ORDER BY order_num, id", [req.params.id]);
    const idx = items.findIndex((i) => String(i.id) === req.params.itemId);
    if (idx === -1) return res.redirect(`/checklist-templates/${req.params.id}`);
    const swapWith = req.params.dir === "up" ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= items.length) return res.redirect(`/checklist-templates/${req.params.id}`);
    const a = items[idx];
    const b = items[swapWith];
    await db.run("UPDATE checklist_template_items SET order_num = ? WHERE id = ?", [b.order_num, a.id]);
    await db.run("UPDATE checklist_template_items SET order_num = ? WHERE id = ?", [a.order_num, b.id]);
    res.redirect(`/checklist-templates/${req.params.id}`);
  })
);

module.exports = router;
