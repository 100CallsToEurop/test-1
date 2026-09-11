const express = require("express");
const { db } = require("../db");
const { requireLogin, logAction } = require("../authMiddleware");
const { setFlash } = require("../flash");
const { ah } = require("../asyncHandler");

const router = express.Router();

router.get(
  "/",
  requireLogin,
  ah(async (req, res) => {
    const { status, criticality, q } = req.query;
    let sql = `SELECT nc.*, u.full_name AS assignee_name, c.full_name AS creator_name
       FROM nonconformities nc
       LEFT JOIN users u ON u.id = nc.assignee_id
       LEFT JOIN users c ON c.id = nc.created_by
       WHERE 1=1`;
    const params = [];
    if (status) {
      sql += " AND nc.status = ?";
      params.push(status);
    }
    if (criticality) {
      sql += " AND nc.criticality = ?";
      params.push(criticality);
    }
    if (q) {
      sql += " AND nc.description ILIKE ?";
      params.push(`%${q}%`);
    }
    sql += " ORDER BY nc.status != 'closed' DESC, nc.criticality = 'critical' DESC, nc.created_at DESC";
    const items = await db.all(sql, params);
    res.render("nonconformities/list", { title: "Несоответствия", items, query: req.query });
  })
);

router.get(
  "/new",
  requireLogin,
  ah(async (req, res) => {
    const users = await db.all("SELECT * FROM users WHERE status='active' ORDER BY full_name");
    res.render("nonconformities/new", {
      title: "Регистрация несоответствия",
      users,
      recordId: req.query.record_id || "",
      batchId: req.query.batch_id || "",
      error: null,
    });
  })
);

router.post(
  "/",
  requireLogin,
  ah(async (req, res) => {
    const { description, criticality, record_id, batch_id } = req.body;
    if (!description || !description.trim()) {
      const users = await db.all("SELECT * FROM users WHERE status='active' ORDER BY full_name");
      return res.status(400).render("nonconformities/new", {
        title: "Регистрация несоответствия",
        users,
        recordId: record_id || "",
        batchId: batch_id || "",
        error: "Заполните описание несоответствия",
      });
    }
    const info = await db.run(
      `INSERT INTO nonconformities (description, criticality, record_id, batch_id, created_by) VALUES (?, ?, ?, ?, ?) RETURNING id`,
      [description.trim(), criticality === "critical" ? "critical" : "normal", record_id || null, batch_id || null, req.user.id]
    );
    await logAction(req.user.id, "create", "nonconformity", info.lastInsertId);
    setFlash(req, "success", "Несоответствие зарегистрировано");
    res.redirect(`/nonconformities/${info.lastInsertId}`);
  })
);

router.get(
  "/:id",
  requireLogin,
  ah(async (req, res) => {
    const nc = await db.get(
      `SELECT nc.*, u.full_name AS assignee_name, c.full_name AS creator_name, cl.full_name AS closer_name,
              ca.full_name AS corrective_action_by_name
       FROM nonconformities nc
       LEFT JOIN users u ON u.id = nc.assignee_id
       LEFT JOIN users c ON c.id = nc.created_by
       LEFT JOIN users cl ON cl.id = nc.closed_by
       LEFT JOIN users ca ON ca.id = nc.corrective_action_by
       WHERE nc.id = ?`,
      [req.params.id]
    );
    if (!nc) return res.status(404).render("error", { title: "Не найдено", message: "Несоответствие не найдено" });
    const users = await db.all("SELECT * FROM users WHERE status='active' ORDER BY full_name");

    let relatedRecord = null;
    if (nc.record_id) {
      relatedRecord = await db.get(
        `SELECT r.*, j.name AS journal_name FROM records r JOIN journals j ON j.id = r.journal_id WHERE r.id = ?`,
        [nc.record_id]
      );
    }

    let relatedAudit = null;
    if (nc.audit_item_id) {
      relatedAudit = await db.get(
        `SELECT a.id, a.title, ai.text AS item_text FROM audit_items ai JOIN audits a ON a.id = ai.audit_id WHERE ai.id = ?`,
        [nc.audit_item_id]
      );
    }

    const segregationBlocked = nc.criticality === "critical" && nc.assignee_id === req.user.id;

    res.render("nonconformities/view", { title: `Несоответствие №${nc.id}`, nc, users, relatedRecord, relatedAudit, segregationBlocked });
  })
);

router.post(
  "/:id/assign",
  requireLogin,
  ah(async (req, res) => {
    if (!["shift_lead", "quality"].includes(req.user.role_code)) {
      return res
        .status(403)
        .render("error", { title: "Доступ запрещён", message: "Назначение исполнителя доступно мастеру смены/начальнику цеха или специалисту по качеству." });
    }
    const { assignee_id, due_date } = req.body;
    await db.run(`UPDATE nonconformities SET status = 'assigned', assignee_id = ?, due_date = ? WHERE id = ?`, [
      assignee_id || null,
      due_date || null,
      req.params.id,
    ]);
    await logAction(req.user.id, "assign", "nonconformity", req.params.id);
    setFlash(req, "success", "Исполнитель назначен");
    res.redirect(`/nonconformities/${req.params.id}`);
  })
);

router.post(
  "/:id/start",
  requireLogin,
  ah(async (req, res) => {
    await db.run(`UPDATE nonconformities SET status = 'in_progress' WHERE id = ?`, [req.params.id]);
    await logAction(req.user.id, "start", "nonconformity", req.params.id);
    setFlash(req, "success", "Взято в работу");
    res.redirect(`/nonconformities/${req.params.id}`);
  })
);

// исполнитель пишет, какую коррекцию будет делать (что именно и как устранит причину)
router.post(
  "/:id/corrective-action",
  requireLogin,
  ah(async (req, res) => {
    const nc = await db.get("SELECT * FROM nonconformities WHERE id = ?", [req.params.id]);
    if (!nc) return res.status(404).render("error", { title: "Не найдено", message: "Несоответствие не найдено" });
    if (nc.assignee_id !== req.user.id && !["quality", "director"].includes(req.user.role_code)) {
      return res.status(403).render("error", { title: "Доступ запрещён", message: "Описать корректирующее действие может назначенный исполнитель, специалист по качеству или руководитель." });
    }
    const { corrective_action } = req.body;
    await db.run("UPDATE nonconformities SET corrective_action = ?, corrective_action_by = ?, corrective_action_at = NOW() WHERE id = ?", [
      corrective_action || "",
      req.user.id,
      nc.id,
    ]);
    await logAction(req.user.id, "corrective_action", "nonconformity", nc.id);
    setFlash(req, "success", "Корректирующее действие сохранено");
    res.redirect(`/nonconformities/${nc.id}`);
  })
);

router.post(
  "/:id/verify",
  requireLogin,
  ah(async (req, res) => {
    if (req.user.role_code !== "quality") {
      return res.status(403).render("error", { title: "Доступ запрещён", message: "Проверку устранения выполняет специалист по качеству." });
    }
    await db.run(`UPDATE nonconformities SET status = 'verified' WHERE id = ?`, [req.params.id]);
    await logAction(req.user.id, "verify", "nonconformity", req.params.id);
    setFlash(req, "success", "Устранение подтверждено");
    res.redirect(`/nonconformities/${req.params.id}`);
  })
);

router.post(
  "/:id/close",
  requireLogin,
  ah(async (req, res) => {
    const nc = await db.get("SELECT * FROM nonconformities WHERE id = ?", [req.params.id]);
    if (!nc) return res.status(404).render("error", { title: "Не найдено", message: "Несоответствие не найдено" });

    if (nc.criticality === "critical" && nc.assignee_id === req.user.id) {
      return res.status(403).render("error", {
        title: "Закрытие заблокировано",
        message: "Критическое несоответствие не может закрыть тот, кто был назначен его исполнителем (раздел 4.2 спецификации — правило разделения обязанностей).",
      });
    }
    if (nc.criticality === "critical" && req.user.role_code !== "director") {
      return res.status(403).render("error", { title: "Закрытие заблокировано", message: "Критическое несоответствие закрывает только руководитель/директор по качеству." });
    }
    if (nc.criticality !== "critical" && !["quality", "director"].includes(req.user.role_code)) {
      return res.status(403).render("error", { title: "Закрытие заблокировано", message: "Закрытие доступно специалисту по качеству или руководителю." });
    }

    await db.run(`UPDATE nonconformities SET status = 'closed', closed_by = ?, closed_at = NOW() WHERE id = ?`, [req.user.id, nc.id]);
    await logAction(req.user.id, "close", "nonconformity", nc.id);
    setFlash(req, "success", "Несоответствие закрыто");
    res.redirect(`/nonconformities/${nc.id}`);
  })
);

module.exports = router;
