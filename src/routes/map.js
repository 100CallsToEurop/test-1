const express = require("express");
const { db } = require("../db");
const { requireLogin, requirePermission, logAction } = require("../authMiddleware");
const { ah } = require("../asyncHandler");
const { periodicityToHours } = require("../scheduler");

const router = express.Router();

const REPORT_CATALOG = [
  ["dashboard", "Дашборд руководителя"],
  ["evidence", "Доказательная база для аудита"],
  ["nonconformities", "Отчёт по несоответствиям"],
  ["traceability", "Отчёт по прослеживаемости партии"],
  ["shift", "Сменный отчёт производства"],
  ["quality_daily", "Суточный отчёт по качеству"],
  ["labor_safety", "Отчёт по охране труда"],
  ["calibration", "Отчёт по срокам поверки СИ"],
  ["stock", "Отчёт по остаткам и срокам годности"],
  ["audits", "Отчёт по внутренним аудитам"],
  ["management_review", "Сводный отчёт для управленческого анализа"],
  ["ecology", "Отчёт по экологическим показателям"],
];

router.get(
  "/",
  requireLogin,
  ah(async (req, res) => {
    const points = await db.all(
      `SELECT mp.*, s.name AS standard_name
       FROM map_points mp JOIN standards s ON s.id = mp.standard_id
       ORDER BY s.name, mp.clause`
    );
    for (const p of points) {
      p.journals = await db.all(
        `SELECT j.*, (SELECT MAX(created_at) FROM records r WHERE r.journal_id = j.id) AS last_record_at
         FROM journals j WHERE j.map_point_id = ? ORDER BY j.name`,
        [p.id]
      );
      p.journals.forEach((j) => {
        const hours = periodicityToHours(j.periodicity);
        j.overdue = hours && (!j.last_record_at || Date.now() - new Date(j.last_record_at).getTime() > hours * 3600 * 1000 * 1.2);
        j.tracked = !!hours;
      });
      const reportRows = await db.all("SELECT report_code FROM point_reports WHERE map_point_id = ?", [p.id]);
      p.reportCodes = reportRows.map((r) => r.report_code);
      p.reportNames = p.reportCodes.map((c) => (REPORT_CATALOG.find((r) => r[0] === c) || [c, c])[1]);
      p.doneCount = p.journals.filter((j) => j.last_record_at && !j.overdue).length;
      p.missingCount = p.journals.filter((j) => j.overdue || !j.last_record_at).length;
    }
    const standards = await db.all("SELECT * FROM standards ORDER BY name");
    const unlinkedJournals = await db.all("SELECT * FROM journals WHERE map_point_id IS NULL AND form_type != 'T5' ORDER BY name");
    res.render("map/list", { title: "Карта критических точек", points, standards, unlinkedJournals, reportCatalog: REPORT_CATALOG });
  })
);

router.post(
  "/",
  requireLogin,
  requirePermission("map_edit"),
  ah(async (req, res) => {
    const { standard_id, new_standard, clause, point_type } = req.body;
    let stdId = standard_id;
    if (new_standard && new_standard.trim()) {
      await db.run("INSERT INTO standards (name) VALUES (?) ON CONFLICT (name) DO NOTHING", [new_standard.trim()]);
      const std = await db.get("SELECT id FROM standards WHERE name = ?", [new_standard.trim()]);
      stdId = std.id;
    }
    if (!stdId || !clause) return res.redirect("/map");
    const info = await db.run("INSERT INTO map_points (standard_id, clause, point_type) VALUES (?, ?, ?) RETURNING id", [
      stdId,
      clause.trim(),
      point_type || "other",
    ]);
    await logAction(req.user.id, "create", "map_point", info.lastInsertId);
    res.redirect("/map");
  })
);

router.post(
  "/:id/link",
  requireLogin,
  requirePermission("map_edit"),
  ah(async (req, res) => {
    const { journal_id } = req.body;
    await db.run("UPDATE journals SET map_point_id = ? WHERE id = ?", [req.params.id, journal_id]);
    await logAction(req.user.id, "link_journal", "map_point", req.params.id);
    res.redirect("/map");
  })
);

router.post(
  "/:id/link-report",
  requireLogin,
  requirePermission("map_edit"),
  ah(async (req, res) => {
    const { report_code } = req.body;
    if (report_code) {
      await db.run("INSERT INTO point_reports (map_point_id, report_code) VALUES (?, ?) ON CONFLICT DO NOTHING", [req.params.id, report_code]);
    }
    res.redirect("/map");
  })
);

router.post(
  "/unlink/:journalId",
  requireLogin,
  requirePermission("map_edit"),
  ah(async (req, res) => {
    await db.run("UPDATE journals SET map_point_id = NULL WHERE id = ?", [req.params.journalId]);
    await logAction(req.user.id, "unlink_journal", "journal", req.params.journalId);
    res.redirect("/map");
  })
);

module.exports = router;
