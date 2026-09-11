const app = require("./app");
const { run: seed } = require("./seed");
const { startScheduler } = require("./scheduler");
const { pool } = require("./db");

const PORT = process.env.PORT || 3000;

async function main() {
  await seed(); // идемпотентно — безопасно на каждом старте
  startScheduler();
  app.listen(PORT, () => {
    console.log(`MerSI ISM Platform запущена: http://localhost:${PORT}`);
    console.log(`Демо-логины (пароль = логин + "123"): operator, quality, shift_lead, storekeeper, auditor, director, admin`);
  });
}

main().catch((err) => {
  console.error("Не удалось запустить сервер:", err.message);
  console.error("Проверьте DATABASE_URL и доступность PostgreSQL (см. README).");
  pool.end();
  process.exit(1);
});
