const { db } = require("./db");
const { ah } = require("./asyncHandler");

const currentUser = ah(async (req, res, next) => {
  res.locals.user = null;
  if (req.session && req.session.userId) {
    const u = await db.get("SELECT * FROM users WHERE id = ? AND status = 'active'", [req.session.userId]);
    if (u) {
      req.user = u;
      res.locals.user = u;
    }
  }
  next();
});

function requireLogin(req, res, next) {
  if (!req.user) return res.redirect("/login");
  next();
}

// roles: массив допустимых кодов ролей, либо '*' для любого авторизованного
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect("/login");
    if (roles.includes("*") || roles.includes(req.user.role_code)) return next();
    return res.status(403).render("error", { title: "Доступ запрещён", message: "Раздел недоступен для вашей роли." });
  };
}

// Динамические права поверх базовой ролевой модели (раздел "Роли и права" в админке).
// Администратору можно ничего не настраивать — у него доступ всегда есть.
async function can(user, permission) {
  if (!user) return false;
  if (user.role_code === "admin") return true;
  const row = await db.get("SELECT 1 x FROM role_permissions WHERE role_code = ? AND permission = ?", [user.role_code, permission]);
  return !!row;
}

function requirePermission(permission) {
  return ah(async (req, res, next) => {
    if (!req.user) return res.redirect("/login");
    if (await can(req.user, permission)) return next();
    return res.status(403).render("error", {
      title: "Доступ запрещён",
      message: "Этот раздел недоступен вашей роли. Администратор может выдать доступ в разделе «Роли и права».",
    });
  });
}

async function logAction(actorId, action, entity, entityId, before, after) {
  await db.run(
    `INSERT INTO audit_log (actor_id, action, entity, entity_id, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)`,
    [actorId || null, action, entity, entityId || null, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]
  );
}

module.exports = { currentUser, requireLogin, requireRole, can, requirePermission, logAction };
