const fs = require("fs");
const path = require("path");
const multer = require("multer");

const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safeExt = path.extname(file.originalname).replace(/[^a-zA-Z0-9.]/g, "").slice(0, 10);
    const name = `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 МБ на файл — достаточно для фото с телефона
});

function isImage(filename) {
  return /\.(jpe?g|png|gif|webp|heic|heif)$/i.test(filename || "");
}

module.exports = { upload, UPLOAD_DIR, isImage };
