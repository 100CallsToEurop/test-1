// Express не ловит отклонённые промисы из async-обработчиков сам по себе —
// оборачиваем каждый роут, чтобы ошибка уходила в app.use((err,...)) в app.js.
function ah(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { ah };
