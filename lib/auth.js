const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query } = require('../db');

function pinLookup(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

function validatePin(pin) {
  return /^\d{4,12}$/.test(String(pin || ''));
}

async function findUserByPin(pin) {
  if (!validatePin(pin)) return null;
  const result = await query(
    'SELECT id, name, role, active, pin_hash FROM users WHERE pin_lookup = $1 LIMIT 1',
    [pinLookup(pin)]
  );
  if (!result.rowCount) return null;
  const user = result.rows[0];
  if (!user.active || !(await bcrypt.compare(String(pin), user.pin_hash))) return null;
  delete user.pin_hash;
  return user;
}

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (!roles.includes(req.session.user.role)) return res.status(403).render('error', { message: '접근 권한이 없습니다.' });
    next();
  };
}

function requireEvaluator(req, res, next) {
  return requireRole('student', 'teacher')(req, res, next);
}

module.exports = { pinLookup, validatePin, findUserByPin, requireLogin, requireRole, requireEvaluator };
