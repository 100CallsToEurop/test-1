// Короткое уведомление после действия ("Запись сохранена" и т.п.), переживает
// один redirect через сессию и показывается один раз вверху страницы.
function setFlash(req, type, message) {
  if (req.session) req.session.flash = { type, message };
}

function consumeFlash(req, res, next) {
  res.locals.flash = req.session && req.session.flash ? req.session.flash : null;
  if (req.session && req.session.flash) delete req.session.flash;
  next();
}

module.exports = { setFlash, consumeFlash };
