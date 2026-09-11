const express = require("express");
const { db } = require("../db");
const { requireLogin, logAction } = require("../authMiddleware");
const { ah } = require("../asyncHandler");

const router = express.Router();

async function getBatch(number) {
  return db.get("SELECT * FROM batches WHERE number = ?", [number]);
}

async function ancestors(batchId, seen = new Set()) {
  if (seen.has(batchId)) return [];
  seen.add(batchId);
  const parents = await db.all(`SELECT b.* FROM batch_links l JOIN batches b ON b.id = l.parent_batch_id WHERE l.child_batch_id = ?`, [
    batchId,
  ]);
  let result = [...parents];
  for (const p of parents) {
    result = result.concat(await ancestors(p.id, seen));
  }
  return result;
}

async function descendants(batchId, seen = new Set()) {
  if (seen.has(batchId)) return [];
  seen.add(batchId);
  const children = await db.all(`SELECT b.* FROM batch_links l JOIN batches b ON b.id = l.child_batch_id WHERE l.parent_batch_id = ?`, [
    batchId,
  ]);
  let result = [...children];
  for (const c of children) {
    result = result.concat(await descendants(c.id, seen));
  }
  return result;
}

router.get(
  "/",
  requireLogin,
  ah(async (req, res) => {
    const recent = await db.all("SELECT * FROM batches ORDER BY id DESC LIMIT 20");
    res.render("traceability/search", { title: "Прослеживаемость", recent, notFound: false, query: "" });
  })
);

router.get(
  "/search",
  requireLogin,
  ah(async (req, res) => {
    const q = (req.query.number || "").trim();
    const batch = await getBatch(q);
    if (!batch) {
      const recent = await db.all("SELECT * FROM batches ORDER BY id DESC LIMIT 20");
      return res.render("traceability/search", { title: "Прослеживаемость", recent, notFound: true, query: q });
    }
    res.redirect(`/traceability/${encodeURIComponent(batch.number)}`);
  })
);

router.get(
  "/:number",
  requireLogin,
  ah(async (req, res) => {
    const start = Date.now();
    const batch = await getBatch(req.params.number);
    if (!batch) return res.status(404).render("error", { title: "Не найдено", message: "Партия не найдена" });
    const back = await ancestors(batch.id);
    const fwd = await descendants(batch.id);
    const relatedRecords = await db.all(
      `SELECT r.*, j.name AS journal_name FROM records r JOIN journals j ON j.id = r.journal_id WHERE r.batch_id = ? ORDER BY r.created_at`,
      [batch.id]
    );
    const elapsedMs = Date.now() - start;

    res.render("traceability/card", { title: `Прослеживаемость — ${batch.number}`, batch, back, fwd, relatedRecords, elapsedMs });
  })
);

router.post(
  "/link",
  requireLogin,
  ah(async (req, res) => {
    if (!["quality", "admin"].includes(req.user.role_code)) {
      return res.status(403).render("error", { title: "Доступ запрещён", message: "Связывание партий доступно специалисту по качеству или администратору." });
    }
    const { child_number, parent_number, link_type } = req.body;
    let child = await getBatch(child_number);
    let parent = await getBatch(parent_number);
    if (!child) {
      const info = await db.run("INSERT INTO batches (number, status) VALUES (?, 'active') RETURNING id", [child_number]);
      child = { id: info.lastInsertId };
    }
    if (!parent) {
      const info = await db.run("INSERT INTO batches (number, status) VALUES (?, 'active') RETURNING id", [parent_number]);
      parent = { id: info.lastInsertId };
    }
    await db.run("INSERT INTO batch_links (child_batch_id, parent_batch_id, link_type) VALUES (?, ?, ?)", [
      child.id,
      parent.id,
      link_type || "manual",
    ]);
    await logAction(req.user.id, "link", "batch", child.id);
    res.redirect(`/traceability/${encodeURIComponent(child_number)}`);
  })
);

module.exports = router;
