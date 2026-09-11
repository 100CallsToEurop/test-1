const express = require("express");
const bcrypt = require("bcryptjs");
const { db } = require("../db");
const { requireLogin, requireRole, logAction } = require("../authMiddleware");
const { ah } = require("../asyncHandler");

const router = express.Router();
router.use(requireLogin, requireRole("admin"));

const PERMISSIONS = [
  ["constructor", "Конструктор журналов и чек-листов"],
  ["map_edit", "Редактирование карты критических точек"],
  ["audit_manage", "Планирование и проведение аудитов"],
];

router.get(
  "/",
  ah(async (req, res) => {
    const users = await db.all("SELECT * FROM users ORDER BY full_name");
    const roles = await db.all("SELECT * FROM roles ORDER BY name");
    const journals = await db.all("SELECT * FROM journals ORDER BY group_name, name");
    const auditLog = await db.all(
      `SELECT a.*, u.full_name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.at DESC LIMIT 200`
    );
    const permRows = await db.all("SELECT * FROM role_permissions");
    const permMatrix = {};
    roles.forEach((r) => (permMatrix[r.code] = {}));
    permRows.forEach((p) => {
      if (!permMatrix[p.role_code]) permMatrix[p.role_code] = {};
      permMatrix[p.role_code][p.permission] = true;
    });
    res.render("admin/index", { title: "Администрирование", users, roles, journals, auditLog, permissions: PERMISSIONS, permMatrix });
  })
);

router.post(
  "/users",
  ah(async (req, res) => {
    const { full_name, login, password, role_code, department } = req.body;
    if (!full_name || !login || !password || !role_code) return res.redirect("/admin");
    const hash = bcrypt.hashSync(password, 10);
    const info = await db.run("INSERT INTO users (full_name, login, password_hash, role_code, department) VALUES (?, ?, ?, ?, ?) RETURNING id", [
      full_name.trim(),
      login.trim(),
      hash,
      role_code,
      department || "",
    ]);
    await logAction(req.user.id, "create", "user", info.lastInsertId);
    res.redirect("/admin");
  })
);

router.post(
  "/users/:id/toggle",
  ah(async (req, res) => {
    const u = await db.get("SELECT * FROM users WHERE id = ?", [req.params.id]);
    if (!u) return res.redirect("/admin");
    const status = u.status === "active" ? "blocked" : "active";
    await db.run("UPDATE users SET status = ? WHERE id = ?", [status, u.id]);
    await logAction(req.user.id, "toggle_status", "user", u.id, { status: u.status }, { status });
    res.redirect("/admin");
  })
);

router.post(
  "/journals/:id/toggle",
  ah(async (req, res) => {
    const j = await db.get("SELECT * FROM journals WHERE id = ?", [req.params.id]);
    if (!j) return res.redirect("/admin");
    await db.run("UPDATE journals SET active = ? WHERE id = ?", [j.active ? 0 : 1, j.id]);
    await logAction(req.user.id, "toggle_active", "journal", j.id);
    res.redirect("/admin");
  })
);

// --- роли: администратор может добавить новую роль ---
router.post(
  "/roles",
  ah(async (req, res) => {
    const { code, name } = req.body;
    if (!code || !name) return res.redirect("/admin#roles");
    const cleanCode = code.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
    await db.run("INSERT INTO roles (code, name) VALUES (?, ?) ON CONFLICT (code) DO NOTHING", [cleanCode, name.trim()]);
    await logAction(req.user.id, "create", "role", null, null, { code: cleanCode, name });
    res.redirect("/admin#roles");
  })
);

// --- права ролей: чекбоксы constructor / map_edit / audit_manage ---
router.post(
  "/roles/:code/permissions",
  ah(async (req, res) => {
    const roleCode = req.params.code;
    const enabled = Array.isArray(req.body.permissions) ? req.body.permissions : req.body.permissions ? [req.body.permissions] : [];
    await db.run("DELETE FROM role_permissions WHERE role_code = ?", [roleCode]);
    for (const perm of enabled) {
      if (PERMISSIONS.some((p) => p[0] === perm)) {
        await db.run("INSERT INTO role_permissions (role_code, permission) VALUES (?, ?)", [roleCode, perm]);
      }
    }
    await logAction(req.user.id, "update_permissions", "role", null, null, { role: roleCode, permissions: enabled });
    res.redirect("/admin#roles");
  })
);

// --- назначение журналов конкретному пользователю ---
router.get(
  "/users/:id/journals",
  ah(async (req, res) => {
    const targetUser = await db.get("SELECT * FROM users WHERE id = ?", [req.params.id]);
    if (!targetUser) return res.status(404).render("error", { title: "Не найдено", message: "Пользователь не найден" });
    const journals = await db.all("SELECT * FROM journals WHERE form_type != 'T5' ORDER BY group_name, name");
    const assignedRows = await db.all("SELECT journal_id FROM user_journals WHERE user_id = ?", [req.params.id]);
    const assigned = new Set(assignedRows.map((r) => r.journal_id));
    const byGroup = {};
    journals.forEach((j) => {
      if (!byGroup[j.group_name]) byGroup[j.group_name] = [];
      byGroup[j.group_name].push(j);
    });
    res.render("admin/user_journals", { title: `Журналы для ${targetUser.full_name}`, targetUser, byGroup, assigned });
  })
);

router.post(
  "/users/:id/journals",
  ah(async (req, res) => {
    const journalIds = Array.isArray(req.body.journal_ids) ? req.body.journal_ids : req.body.journal_ids ? [req.body.journal_ids] : [];
    await db.run("DELETE FROM user_journals WHERE user_id = ?", [req.params.id]);
    for (const jid of journalIds) {
      await db.run("INSERT INTO user_journals (user_id, journal_id) VALUES (?, ?) ON CONFLICT DO NOTHING", [req.params.id, jid]);
    }
    await logAction(req.user.id, "assign_journals", "user", req.params.id, null, { count: journalIds.length });
    res.redirect(`/admin/users/${req.params.id}/journals`);
  })
);

module.exports = router;
