const Decimal = require('decimal.js');
const { decimal } = require('./config');

const toAtomic = (value) => {
  if (value === undefined || value === null || value === '') return 0n;
  const dec = new Decimal(value);
  const scaled = dec.mul(new Decimal(decimal.multiplier.toString()));
  return BigInt(scaled.toFixed(0));
};

const fromAtomic = (value) => {
  const bigintValue = typeof value === 'bigint' ? value : BigInt(value || 0);
  const dec = new Decimal(bigintValue.toString());
  return dec.div(new Decimal(decimal.multiplier.toString()));
};

const toDisplay = (value, precision = Number(decimal.scale)) => {
  return fromAtomic(value).toFixed(precision);
};

const addAtomic = (...values) => values.reduce((sum, val) => sum + BigInt(val || 0), 0n);

const subtractAtomic = (a, b) => BigInt(a || 0) - BigInt(b || 0);

const multiplyAtomic = (a, b) => {
  const decA = new Decimal(fromAtomic(a).toString());
  const decB = new Decimal(b.toString());
  return toAtomic(decA.mul(decB).toString());
};

module.exports = {
  toAtomic,
  fromAtomic,
  toDisplay,
  addAtomic,
  subtractAtomic,
  multiplyAtomic,
};
