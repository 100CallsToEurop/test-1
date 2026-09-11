const express = require("express");
const { db } = require("../db");
const { requireLogin, requirePermission, can, logAction } = require("../authMiddleware");
const { setFlash } = require("../flash");
const { ah } = require("../asyncHandler");
const { upload } = require("../uploads");

const router = express.Router();

router.get(
  "/",
  requireLogin,
  ah(async (req, res) => {
    const { status, from, to } = req.query;
    let sql = `SELECT a.*, u1.full_name AS auditor_name, u2.full_name AS responsible_name, s.name AS standard_name,
                      (SELECT COUNT(*) FROM audit_items ai WHERE ai.audit_id = a.id) AS items_count,
                      (SELECT COUNT(*) FROM audit_items ai WHERE ai.audit_id = a.id AND ai.result != 'compliant') AS findings_count
               FROM audits a
               LEFT JOIN users u1 ON u1.id = a.auditor_id
               LEFT JOIN users u2 ON u2.id = a.responsible_id
               LEFT JOIN standards s ON s.id = a.standard_id
               WHERE 1=1`;
    const params = [];
    if (status) {
      sql += " AND a.status = ?";
      params.push(status);
    }
    if (from) {
      sql += " AND a.planned_date >= ?";
      params.push(from);
    }
    if (to) {
      sql += " AND a.planned_date <= ?";
      params.push(to);
    }
    sql += " ORDER BY a.planned_date";
    const audits = await db.all(sql, params);
    res.render("audits/list", { title: "Аудиты — план и календарь", audits, query: req.query });
  })
);

router.get(
  "/new",
  requireLogin,
  requirePermission("audit_manage"),
  ah(async (req, res) => {
    const standards = await db.all("SELECT * FROM standards ORDER BY name");
    const points = await db.all(
      `SELECT mp.id, mp.clause, s.name AS standard_name FROM map_points mp JOIN standards s ON s.id = mp.standard_id ORDER BY s.name, mp.clause`
    );
    const users = await db.all("SELECT * FROM users WHERE status='active' ORDER BY full_name");
    res.render("audits/new", { title: "Новый аудит", standards, points, users, error: null });
  })
);

router.post(
  "/",
  requireLogin,
  requirePermission("audit_manage"),
  ah(async (req, res) => {
    const { title, standard_id, map_point_id, planned_date, auditor_id, responsible_id } = req.body;
    if (!title || !title.trim()) {
      const standards = await db.all("SELECT * FROM standards ORDER BY name");
      const points = await db.all(
        `SELECT mp.id, mp.clause, s.name AS standard_name FROM map_points mp JOIN standards s ON s.id = mp.standard_id ORDER BY s.name, mp.clause`
      );
      const users = await db.all("SELECT * FROM users WHERE status='active' ORDER BY full_name");
      return res.status(400).render("audits/new", { title: "Новый аудит", standards, points, users, error: "Укажите название аудита" });
    }
    const info = await db.run(
      `INSERT INTO audits (title, standard_id, map_point_id, planned_date, auditor_id, responsible_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [title.trim(), standard_id || null, map_point_id || null, planned_date || null, auditor_id || null, responsible_id || null, req.user.id]
    );
    await logAction(req.user.id, "create", "audit", info.lastInsertId);
    setFlash(req, "success", "Аудит запланирован");
    res.redirect(`/audits/${info.lastInsertId}`);
  })
);

router.get(
  "/:id",
  requireLogin,
  ah(async (req, res) => {
    const audit = await db.get(
      `SELECT a.*, u1.full_name AS auditor_name, u2.full_name AS responsible_name, u3.full_name AS response_by_name,
              s.name AS standard_name, mp.clause AS map_clause
       FROM audits a
       LEFT JOIN users u1 ON u1.id = a.auditor_id
       LEFT JOIN users u2 ON u2.id = a.responsible_id
       LEFT JOIN users u3 ON u3.id = a.response_by
       LEFT JOIN standards s ON s.id = a.standard_id
       LEFT JOIN map_points mp ON mp.id = a.map_point_id
       WHERE a.id = ?`,
      [req.params.id]
    );
    if (!audit) return res.status(404).render("error", { title: "Не найдено", message: "Аудит не найден" });
    const items = await db.all(
      `SELECT ai.*, nc.id AS nc_id, nc.status AS nc_status FROM audit_items ai LEFT JOIN nonconformities nc ON nc.audit_item_id = ai.id
       WHERE ai.audit_id = ? ORDER BY ai.id`,
      [audit.id]
    );
    const isManager = await can(req.user, "audit_manage");
    const templates = isManager
      ? await db.all(
          `SELECT t.*, (SELECT COUNT(*) FROM checklist_template_items i WHERE i.template_id = t.id) AS items_count FROM checklist_templates t ORDER BY t.category, t.name`
        )
      : [];
    res.render("audits/view", {
      title: audit.title,
      audit,
      items,
      isManager,
      templates,
      isResponsible: audit.responsible_id === req.user.id,
      isAuditor: audit.auditor_id === req.user.id,
    });
  })
);

// применить готовый шаблон чек-листа — копирует пункты в аудит как «ожидающие ответа»
router.post(
  "/:id/apply-template",
  requireLogin,
  requirePermission("audit_manage"),
  ah(async (req, res) => {
    const { template_id } = req.body;
    if (!template_id) return res.redirect(`/audits/${req.params.id}`);
    const items = await db.all("SELECT * FROM checklist_template_items WHERE template_id = ? ORDER BY order_num, id", [template_id]);
    for (const it of items) {
      await db.run("INSERT INTO audit_items (audit_id, text, result, template_item_id) VALUES (?, ?, NULL, ?)", [
        req.params.id,
        it.text,
        it.id,
      ]);
    }
    await logAction(req.user.id, "apply_template", "audit", req.params.id, null, { template_id, count: items.length });
    setFlash(req, "success", `Пунктов добавлено: ${items.length}`);
    res.redirect(`/audits/${req.params.id}`);
  })
);

// ответ на «ожидающий» пункт чек-листа (пришедший из шаблона) — тот же автосоздание
// несоответствия по разделу 4.1.3, что и для пункта, добавленного вручную
router.post(
  "/:id/items/:itemId/answer",
  requireLogin,
  upload.single("photo"),
  ah(async (req, res) => {
    const audit = await db.get("SELECT * FROM audits WHERE id = ?", [req.params.id]);
    if (!audit) return res.status(404).render("error", { title: "Не найдено", message: "Аудит не найден" });
    const item = await db.get("SELECT * FROM audit_items WHERE id = ? AND audit_id = ?", [req.params.itemId, req.params.id]);
    if (!item) return res.status(404).render("error", { title: "Не найдено", message: "Пункт чек-листа не найден" });
    const { result, comment } = req.body;
    const photoPath = req.file ? req.file.filename : item.photo_path;
    await db.run("UPDATE audit_items SET result = ?, comment = ?, photo_path = ? WHERE id = ?", [
      result || "compliant",
      comment || null,
      photoPath,
      item.id,
    ]);
    if ((result === "observation" || result === "critical")) {
      const existingNc = await db.get("SELECT id FROM nonconformities WHERE audit_item_id = ?", [item.id]);
      if (!existingNc) {
        const ncInfo = await db.run(
          `INSERT INTO nonconformities (description, criticality, audit_item_id, created_by) VALUES (?, ?, ?, ?) RETURNING id`,
          [
            `Замечание аудита «${audit.title}»: ${item.text}${comment ? " — " + comment : ""}`,
            result === "critical" ? "critical" : "normal",
            item.id,
            req.user.id,
          ]
        );
        await logAction(req.user.id, "auto_create", "nonconformity", ncInfo.lastInsertId, null, { audit_item_id: item.id });
      }
    }
    await logAction(req.user.id, "answer_item", "audit", audit.id);
    setFlash(req, "success", "Ответ по пункту сохранён");
    res.redirect(`/audits/${audit.id}`);
  })
);

router.post(
  "/:id/start",
  requireLogin,
  requirePermission("audit_manage"),
  ah(async (req, res) => {
    await db.run("UPDATE audits SET status = 'in_progress' WHERE id = ?", [req.params.id]);
    await logAction(req.user.id, "start", "audit", req.params.id);
    setFlash(req, "success", "Аудит начат");
    res.redirect(`/audits/${req.params.id}`);
  })
);

// добавление пункта чек-листа вручную (не из шаблона), с результатом сразу.
// Раздел 4.1.3 спецификации — единственный случай, когда несоответствие
// создаётся автоматически: отметка «Замечание»/«Критическое».
router.post(
  "/:id/items",
  requireLogin,
  upload.single("photo"),
  ah(async (req, res) => {
    const audit = await db.get("SELECT * FROM audits WHERE id = ?", [req.params.id]);
    if (!audit) return res.status(404).render("error", { title: "Не найдено", message: "Аудит не найден" });
    const { text, result, comment } = req.body;
    if (!text || !text.trim()) return res.redirect(`/audits/${audit.id}`);
    const info = await db.run("INSERT INTO audit_items (audit_id, text, result, comment, photo_path) VALUES (?, ?, ?, ?, ?) RETURNING id", [
      audit.id,
      text.trim(),
      result || "compliant",
      comment || null,
      req.file ? req.file.filename : null,
    ]);
    if (result === "observation" || result === "critical") {
      const ncInfo = await db.run(
        `INSERT INTO nonconformities (description, criticality, audit_item_id, created_by) VALUES (?, ?, ?, ?) RETURNING id`,
        [
          `Замечание аудита «${audit.title}»: ${text.trim()}${comment ? " — " + comment : ""}`,
          result === "critical" ? "critical" : "normal",
          info.lastInsertId,
          req.user.id,
        ]
      );
      await logAction(req.user.id, "auto_create", "nonconformity", ncInfo.lastInsertId, null, { audit_item_id: info.lastInsertId });
    }
    await logAction(req.user.id, "add_item", "audit", audit.id);
    setFlash(req, "success", "Пункт добавлен");
    res.redirect(`/audits/${audit.id}`);
  })
);

router.post(
  "/:id/complete",
  requireLogin,
  requirePermission("audit_manage"),
  ah(async (req, res) => {
    await db.run("UPDATE audits SET status = 'completed' WHERE id = ?", [req.params.id]);
    await logAction(req.user.id, "complete", "audit", req.params.id);
    setFlash(req, "success", "Аудит завершён");
    res.redirect(`/audits/${req.params.id}`);
  })
);

// «отправить отчёт ответственному»
router.post(
  "/:id/send",
  requireLogin,
  requirePermission("audit_manage"),
  ah(async (req, res) => {
    const { responsible_id } = req.body;
    await db.run("UPDATE audits SET status = 'sent', responsible_id = COALESCE(?, responsible_id) WHERE id = ?", [
      responsible_id || null,
      req.params.id,
    ]);
    await logAction(req.user.id, "send", "audit", req.params.id);
    setFlash(req, "success", "Отчёт отправлен ответственному");
    res.redirect(`/audits/${req.params.id}`);
  })
);

// ответственный получает отчёт и пишет, какую коррекцию будет делать
router.post(
  "/:id/respond",
  requireLogin,
  ah(async (req, res) => {
    const audit = await db.get("SELECT * FROM audits WHERE id = ?", [req.params.id]);
    if (!audit) return res.status(404).render("error", { title: "Не найдено", message: "Аудит не найден" });
    if (audit.responsible_id !== req.user.id) {
      return res.status(403).render("error", { title: "Доступ запрещён", message: "Ответ на аудит может дать только назначенный ответственный." });
    }
    const { response_text } = req.body;
    await db.run("UPDATE audits SET status = 'responded', response_text = ?, response_by = ?, response_at = NOW() WHERE id = ?", [
      response_text || "",
      req.user.id,
      audit.id,
    ]);
    await logAction(req.user.id, "respond", "audit", audit.id);
    setFlash(req, "success", "Ответ отправлен");
    res.redirect(`/audits/${audit.id}`);
  })
);

router.post(
  "/:id/close",
  requireLogin,
  requirePermission("audit_manage"),
  ah(async (req, res) => {
    await db.run("UPDATE audits SET status = 'closed' WHERE id = ?", [req.params.id]);
    await logAction(req.user.id, "close", "audit", req.params.id);
    setFlash(req, "success", "Аудит закрыт");
    res.redirect(`/audits/${req.params.id}`);
  })
);

module.exports = router;
