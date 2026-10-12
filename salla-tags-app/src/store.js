// تخزين بسيط على ملف JSON: توكنات المتاجر + بصمة آخر محتوى تمت معالجته لكل منتج.
// للإنتاج بدّله بقاعدة بيانات (Postgres/Redis).
const fs = require('fs');
const path = require('path');

const FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'store.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return { merchants: {}, products: {} };
  }
}

function save(db) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
}

const getMerchant = (id) => load().merchants[id];

function setMerchant(id, data) {
  const db = load();
  db.merchants[id] = { ...db.merchants[id], ...data };
  save(db);
}

const getProductHash = (merchantId, productId) => load().products[`${merchantId}:${productId}`];

function setProductHash(merchantId, productId, hash) {
  const db = load();
  db.products[`${merchantId}:${productId}`] = hash;
  save(db);
}

module.exports = { getMerchant, setMerchant, getProductHash, setProductHash };
