const express = require("express");
const { db } = require("../db");
const { requireLogin } = require("../authMiddleware");
const { ah } = require("../asyncHandler");

const router = express.Router();

router.get("/", requireLogin, (req, res) => {
  res.render("reports/index", { title: "Регламентные отчёты" });
});

async function evidenceQuery(req) {
  const { group, map_point_id, from, to } = req.query;
  let sql = `SELECT r.*, j.name AS journal_name, j.group_name, u.full_name AS author_name
             FROM records r JOIN journals j ON j.id = r.journal_id LEFT JOIN users u ON u.id = r.author_id
             WHERE 1=1`;
  const params = [];
  if (group) {
    sql += " AND j.group_name = ?";
    params.push(group);
  }
  if (map_point_id) {
    sql += " AND j.map_point_id = ?";
    params.push(map_point_id);
  }
  if (from) {
    sql += " AND r.created_at::date >= ?::date";
    params.push(from);
  }
  if (to) {
    sql += " AND r.created_at::date <= ?::date";
    params.push(to);
  }
  sql += " ORDER BY r.created_at DESC LIMIT 1000";
  return db.all(sql, params);
}

router.get(
  "/evidence",
  requireLogin,
  ah(async (req, res) => {
    const groups = await db.all("SELECT DISTINCT group_name FROM journals ORDER BY group_name");
    const points = await db.all(
      `SELECT mp.id, mp.clause, s.name AS standard_name FROM map_points mp JOIN standards s ON s.id = mp.standard_id ORDER BY s.name, mp.clause`
    );
    const records = await evidenceQuery(req);
    res.render("reports/evidence", { title: "Доказательная база для аудита", groups, points, records, query: req.query });
  })
);

router.get(
  "/evidence.csv",
  requireLogin,
  ah(async (req, res) => {
    const records = await evidenceQuery(req);
    const header = "id;journal;group;author;created_at;status;deviation;values_json\n";
    const rows = records
      .map((r) =>
        [r.id, r.journal_name, r.group_name, r.author_name, r.created_at, r.status, r.deviation, JSON.stringify(JSON.parse(r.values_json)).replace(/;/g, ",")].join(
          ";"
        )
      )
      .join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=evidence_report.csv");
    res.send("\uFEFF" + header + rows);
  })
);

module.exports = router;
