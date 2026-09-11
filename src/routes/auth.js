const express = require("express");
const bcrypt = require("bcryptjs");
const { db } = require("../db");
const { logAction } = require("../authMiddleware");
const { ah } = require("../asyncHandler");

const router = express.Router();

router.get("/login", (req, res) => {
  if (req.user) return res.redirect("/");
  res.render("login", { title: "Вход", error: null });
});

router.post(
  "/login",
  ah(async (req, res) => {
    const { login, password } = req.body;
    const u = await db.get("SELECT * FROM users WHERE login = ?", [login]);
    if (!u || u.status !== "active" || !bcrypt.compareSync(password || "", u.password_hash)) {
      return res.status(401).render("login", { title: "Вход", error: "Неверный логин или пароль, либо учётная запись заблокирована." });
    }
    req.session.userId = u.id;
    await logAction(u.id, "login", "user", u.id);
    res.redirect("/");
  })
);

router.post("/logout", (req, res) => {
  const uid = req.user ? req.user.id : null;
  req.session.destroy(async () => {
    if (uid) await logAction(uid, "logout", "user", uid);
    res.redirect("/login");
  });
});

module.exports = router;
