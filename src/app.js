const path = require("path");
const express = require("express");
const session = require("express-session");
const expressLayouts = require("express-ejs-layouts");
require("dotenv").config();

const { currentUser } = require("./authMiddleware");
const { consumeFlash } = require("./flash");
const { ah } = require("./asyncHandler");
const { db } = require("./db");

const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.set("layout", "layout");
app.use(expressLayouts);

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "mersi-ism-dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 8 * 60 * 60 * 1000 }, // 8 часов — рабочая смена
  })
);

app.use(currentUser);
app.use(consumeFlash);

// дерево групп журналов для левой панели навигации
app.use(
  ah(async (req, res, next) => {
    if (req.user) {
      res.locals.navGroups = await db.all("SELECT DISTINCT group_name FROM journals WHERE active = 1 ORDER BY group_name");
    }
    next();
  })
);

// делаем текущего пользователя и путь доступными во всех вьюхах без явной передачи
app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  next();
});

app.use("/", require("./routes/auth"));
app.use("/", require("./routes/dashboard"));
app.use("/journals", require("./routes/journals"));
app.use("/records", require("./routes/records"));
app.use("/nonconformities", require("./routes/nonconformities"));
app.use("/traceability", require("./routes/traceability"));
app.use("/map", require("./routes/map"));
app.use("/audits", require("./routes/audits"));
app.use("/checklist-templates", require("./routes/checklistTemplates"));
app.use("/constructor", require("./routes/constructor"));
app.use("/reports", require("./routes/reports"));
app.use("/admin", require("./routes/admin"));

app.use((req, res) => {
  res.status(404).render("error", { title: "Страница не найдена", message: `Нет такого раздела: ${req.path}` });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render("error", { title: "Ошибка", message: err.message || "Внутренняя ошибка сервера" });
});

module.exports = app;
