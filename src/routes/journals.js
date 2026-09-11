const express = require("express");
const { db } = require("../db");
const { requireLogin, can } = require("../authMiddleware");
const { ah } = require("../asyncHandler");

const router = express.Router();

const FULL_ACCESS_ROLES = ["admin", "quality", "director"];

router.get(
  "/",
  requireLogin,
  ah(async (req, res) => {
    const { group, standard_id, form_type, q } = req.query;
    const fullAccess = FULL_ACCESS_ROLES.includes(req.user.role_code) || (await can(req.user, "constructor"));

    let sql = `SELECT j.*, mp.clause AS map_clause, mp.point_type AS map_point_type, s.id AS standard_id, s.name AS standard_name,
              (SELECT COUNT(*) FROM records r WHERE r.journal_id = j.id) AS records_count
       FROM journals j
       LEFT JOIN map_points mp ON mp.id = j.map_point_id
       LEFT JOIN standards s ON s.id = mp.standard_id`;
    const params = [];
    const where = ["j.active = 1"];

    if (!fullAccess) {
      sql += " JOIN user_journals uj ON uj.journal_id = j.id AND uj.user_id = ?";
      params.push(req.user.id);
    }
    if (group) {
      where.push("j.group_name = ?");
      params.push(group);
    }
    if (standard_id) {
      where.push("s.id = ?");
      params.push(standard_id);
    }
    if (form_type) {
      where.push("j.form_type = ?");
      params.push(form_type);
    }
    if (q) {
      where.push("j.name ILIKE ?");
      params.push(`%${q}%`);
    }
    sql += " WHERE " + where.join(" AND ") + " ORDER BY j.group_name, j.name";

    const rows = await db.all(sql, params);
    const groupsList = await db.all("SELECT DISTINCT group_name FROM journals ORDER BY group_name");
    const standards = await db.all("SELECT * FROM standards ORDER BY name");

    const byGroup = {};
    rows.forEach((j) => {
      if (!byGroup[j.group_name]) byGroup[j.group_name] = [];
      byGroup[j.group_name].push(j);
    });

    res.render("journals/list", {
      title: "Библиотека журналов",
      byGroup,
      groupsList,
      standards,
      query: req.query,
      fullAccess,
      totalCount: rows.length,
    });
  })
);

// сводная страница «журналы по требованиям» — группировка по стандарту/пункту
router.get(
  "/by-requirement",
  requireLogin,
  ah(async (req, res) => {
    const points = await db.all(
      `SELECT mp.id, mp.clause, mp.point_type, s.name AS standard_name
       FROM map_points mp JOIN standards s ON s.id = mp.standard_id ORDER BY s.name, mp.clause`
    );
    for (const p of points) {
      p.journals = await db.all("SELECT id, name, group_name, form_type, active FROM journals WHERE map_point_id = ? ORDER BY name", [p.id]);
    }
    const unassigned = await db.all("SELECT id, name, group_name FROM journals WHERE map_point_id IS NULL AND form_type != 'T5' ORDER BY name");
    res.render("journals/by_requirement", { title: "Журналы по требованиям", points, unassigned });
  })
);

router.get(
  "/:id",
  requireLogin,
  ah(async (req, res) => {
    const journal = await db.get(
      `SELECT j.*, mp.clause AS map_clause, s.name AS standard_name FROM journals j
       LEFT JOIN map_points mp ON mp.id = j.map_point_id LEFT JOIN standards s ON s.id = mp.standard_id WHERE j.id = ?`,
      [req.params.id]
    );
    if (!journal) return res.status(404).render("error", { title: "Не найдено", message: "Журнал не найден" });

    if (journal.form_type === "T5") {
      const map = { nonconformity: "/nonconformities", audit: "/audits", system: "/admin" };
      return res.redirect(map[journal.special_module] || "/journals");
    }

    const schema = await db.get("SELECT * FROM schema_versions WHERE journal_id = ? ORDER BY id DESC LIMIT 1", [journal.id]);
    const fields = JSON.parse(schema.fields_json);

    const { sort, dir, q, from, to } = req.query;
    let records = await db.all(
      `SELECT r.*, u.full_name AS author_name, v.full_name AS verifier_name
       FROM records r LEFT JOIN users u ON u.id = r.author_id LEFT JOIN users v ON v.id = r.verified_by
       WHERE r.journal_id = ? ORDER BY r.created_at DESC LIMIT 500`,
      [journal.id]
    );

    // фильтр/поиск/сортировка — на стороне приложения (значения записей хранятся как JSON)
    records = records.map((r) => ({ ...r, _values: JSON.parse(r.values_json) }));
    const lastRecord = records[0] || null; // самая свежая запись — до применения фильтра/сортировки, для подсказки при вводе

    if (q) {
      const needle = q.toLowerCase();
      records = records.filter(
        (r) =>
          (r.author_name || "").toLowerCase().includes(needle) ||
          Object.values(r._values).some((v) => String(Array.isArray(v) ? v.flat().join(" ") : v).toLowerCase().includes(needle))
      );
    }
    if (from) records = records.filter((r) => r.created_at >= from);
    if (to) records = records.filter((r) => r.created_at <= to + "T23:59:59");

    if (sort) {
      records.sort((a, b) => {
        const va = sort === "author" ? a.author_name : sort === "created_at" ? a.created_at : a._values[sort];
        const vb = sort === "author" ? b.author_name : sort === "created_at" ? b.created_at : b._values[sort];
        if (va === vb) return 0;
        return (va > vb ? 1 : -1) * (dir === "desc" ? -1 : 1);
      });
    }

    const view = req.query.view === "table" ? "table" : "list";

    // «быстрое добавление» прямо в списке — только для коротких форм без фото/таблиц показателей
    const quickEligible = fields.length > 0 && fields.length <= 6 && fields.every((f) => f.type !== "photo" && f.type !== "indicator_table");

    res.render(view === "table" ? "journals/records_table" : "journals/records", {
      title: journal.name,
      journal,
      fields,
      records,
      view,
      query: req.query,
      quickEligible,
      lastRecord,
    });
  })
);

module.exports = router;
