const cron = require("node-cron");
const { db } = require("./db");

function periodicityToHours(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  const hoursMatch = t.match(/(\d+)\s*час/);
  if (hoursMatch) return parseInt(hoursMatch[1], 10);
  if (t.includes("на каждую смену") || t.includes("каждую смену")) return 12;
  if (t.includes("ежедневно")) return 24;
  if (t.includes("еженедельно")) return 24 * 7;
  if (t.includes("ежемесячно")) return 24 * 30;
  if (t.includes("ежегодно")) return 24 * 365;
  return null;
}

async function getOverdueJournals() {
  const journals = await db.all("SELECT * FROM journals WHERE active = 1 AND form_type != 'T5'");
  const now = Date.now();
  const overdue = [];
  for (const j of journals) {
    const hours = periodicityToHours(j.periodicity);
    if (!hours) continue;
    const last = await db.get("SELECT created_at FROM records WHERE journal_id = ? ORDER BY created_at DESC LIMIT 1", [j.id]);
    const lastTime = last ? new Date(last.created_at).getTime() : null;
    const dueMs = hours * 3600 * 1000 * 1.2;
    if (!lastTime || now - lastTime > dueMs) {
      overdue.push({ journal: j, lastRecordAt: last ? last.created_at : null, expectedIntervalHours: hours });
    }
  }
  return overdue;
}

function startScheduler() {
  cron.schedule("0 * * * *", async () => {
    try {
      const overdue = await getOverdueJournals();
      if (overdue.length) console.log(`[scheduler] Просроченных журналов: ${overdue.length}`);
    } catch (err) {
      console.error("[scheduler] ошибка проверки просрочек:", err.message);
    }
  });
}

module.exports = { startScheduler, getOverdueJournals, periodicityToHours };
