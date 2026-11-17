'use strict';
// Lossless JSON: numbers and strings keep their exact original text, so an
// unedited save re-serializes byte-for-byte identical to what the game wrote.

class Num {
  constructor(raw) { this.raw = raw; }
  get value() { return Number(this.raw); }
  get isFloat() { return /[.eE]/.test(this.raw); }
  toJSON() { return this.value; }
  /** A new number in the game's style: floats always carry a decimal point. */
  static float(v) {
    if (!Number.isFinite(v)) throw new Error('Not a finite number: ' + v);
    let s = String(v);
    if (Number.isInteger(v) && !/[eE]/.test(s)) s += '.0';
    return new Num(s);
  }
  static int(v) {
    if (!Number.isInteger(v)) throw new Error('Not an integer: ' + v);
    return new Num(String(v));
  }
  /** Same kind (int/float) as an existing Num. */
  static like(existing, v) {
    return existing instanceof Num && !existing.isFloat ? Num.int(Math.round(v)) : Num.float(v);
  }
}

class Str {
  constructor(raw) { this.raw = raw; }
  get value() { return JSON.parse(this.raw); }
  toJSON() { return this.value; }
  static of(s) { return new Str(JSON.stringify(s)); }
}

function parse(text) {
  let i = 0;
  const n = text.length;
  const ws = () => { while (i < n && (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t')) i++; };
  const fail = (msg) => { throw new SyntaxError(`${msg} at position ${i}`); };
  function str() {
    const start = i;
    i++; // opening quote
    while (i < n) {
      const ch = text[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') { i++; return text.slice(start, i); }
      i++;
    }
    fail('Unterminated string');
  }
  function value() {
    ws();
    const ch = text[i];
    if (ch === '{') {
      i++; const obj = {}; ws();
      if (text[i] === '}') { i++; return obj; }
      for (;;) {
        ws(); if (text[i] !== '"') fail('Expected key');
        const key = JSON.parse(str());
        ws(); if (text[i] !== ':') fail('Expected :'); i++;
        if (Object.prototype.hasOwnProperty.call(obj, key)) fail('Duplicate key ' + key);
        obj[key] = value(); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return obj; }
        fail('Expected , or }');
      }
    }
    if (ch === '[') {
      i++; const arr = []; ws();
      if (text[i] === ']') { i++; return arr; }
      for (;;) {
        arr.push(value()); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return arr; }
        fail('Expected , or ]');
      }
    }
    if (ch === '"') return new Str(str());
    if (text.startsWith('true', i)) { i += 4; return true; }
    if (text.startsWith('false', i)) { i += 5; return false; }
    if (text.startsWith('null', i)) { i += 4; return null; }
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 64));
    if (!m) fail('Unexpected character');
    i += m[0].length;
    return new Num(m[0]);
  }
  const v = value(); ws();
  if (i !== n) fail('Trailing data');
  return v;
}

function stringify(v) {
  if (v instanceof Num || v instanceof Str) return v.raw;
  if (v === null) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (Array.isArray(v)) return '[' + v.map(stringify).join(',') + ']';
  if (typeof v === 'object') {
    return '{' + Object.keys(v).map((k) => JSON.stringify(k) + ':' + stringify(v[k])).join(',') + '}';
  }
  if (typeof v === 'number') return Num.float(v).raw; // safety net: never emit raw JS numbers silently
  if (typeof v === 'string') return JSON.stringify(v);
  throw new Error('Cannot serialize ' + typeof v);
}

/** Deep copy of a parsed tree (Num/Str are immutable, so they can be shared). */
function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object' && !(v instanceof Num) && !(v instanceof Str)) {
    const o = {};
    for (const k of Object.keys(v)) o[k] = clone(v[k]);
    return o;
  }
  return v;
}

/** Plain value of a node (Num -> number, Str -> string). */
function val(v) {
  if (v instanceof Num || v instanceof Str) return v.value;
  return v;
}

/** Structural equality on the exact text of every leaf. */
function equal(a, b) {
  return stringify(a) === stringify(b);
}

/** List of paths whose content differs (leaf level, plus added/removed keys and list length changes). */
function diff(a, b, path = '', out = []) {
  const isNode = (x) => x && typeof x === 'object' && !(x instanceof Num) && !(x instanceof Str);
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) { out.push(path); return out; }
    for (let i = 0; i < a.length; i++) diff(a[i], b[i], `${path}[${i}]`, out);
    return out;
  }
  if (isNode(a) && isNode(b) && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!(k in a) || !(k in b)) out.push(`${path}.${k}`);
      else diff(a[k], b[k], `${path}.${k}`, out);
    }
    return out;
  }
  if (stringify(a) !== stringify(b)) out.push(path);
  return out;
}

module.exports = { Num, Str, parse, stringify, clone, val, equal, diff };
