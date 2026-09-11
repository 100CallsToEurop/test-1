const express = require("express");
const { db } = require("../db");
const { requireLogin } = require("../authMiddleware");
const { getOverdueJournals } = require("../scheduler");
const { ah } = require("../asyncHandler");

const router = express.Router();

router.get(
  "/",
  requireLogin,
  ah(async (req, res) => {
    const overdue = await getOverdueJournals();
    const openNc = await db.all(
      `SELECT nc.*, u.full_name AS assignee_name
       FROM nonconformities nc LEFT JOIN users u ON u.id = nc.assignee_id
       WHERE nc.status != 'closed' ORDER BY nc.criticality = 'critical' DESC, nc.created_at DESC LIMIT 20`
    );
    const recentDeviations = await db.all(
      `SELECT r.*, j.name AS journal_name FROM records r JOIN journals j ON j.id = r.journal_id
       WHERE r.deviation = 1 ORDER BY r.created_at DESC LIMIT 10`
    );
    const totals = {
      journals: (await db.get("SELECT COUNT(*) c FROM journals WHERE active = 1")).c,
      records: (await db.get("SELECT COUNT(*) c FROM records")).c,
      openNc: (await db.get("SELECT COUNT(*) c FROM nonconformities WHERE status != 'closed'")).c,
      criticalNc: (await db.get("SELECT COUNT(*) c FROM nonconformities WHERE status != 'closed' AND criticality = 'critical'")).c,
    };
    const myAuditsToRespond = await db.all(
      `SELECT a.* FROM audits a WHERE a.status = 'sent' AND a.responsible_id = ? ORDER BY a.planned_date`,
      [req.user.id]
    );

    res.render("dashboard", { title: "Дашборд", overdue, openNc, recentDeviations, totals, myAuditsToRespond });
  })
);

module.exports = router;
