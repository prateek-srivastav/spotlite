// Arithmetic for the Calculator row: + - * / % ^ (or **) and parentheses.
// A tiny recursive-descent parser, so nothing typed is ever eval()ed.

const ALLOWED = /^[\d\s.+\-*/%^()]+$/;
// at least one operator between two operands, so "2024" alone isn't a sum
const HAS_OPERATOR = /[\d)]\s*(\*\*|[-+*/%^])\s*[\d(.]/;

function tokenize(text) {
  const tokens = [];
  const re = /\s*(\d+\.?\d*|\.\d+|\*\*|[-+*/%^()])/y;
  let m;
  while (re.lastIndex < text.length && (m = re.exec(text)))
    tokens.push(m[1]);
  if (re.lastIndex < text.trimEnd().length)
    throw new Error("unexpected character");
  return tokens;
}

function parse(tokens) {
  let i = 0;
  const peek = () => tokens[i];
  const take = () => tokens[i++];

  // expr := term (("+" | "-") term)*
  function expr() {
    let v = term();
    while (peek() === "+" || peek() === "-")
      v = take() === "+" ? v + term() : v - term();
    return v;
  }
  // term := unary (("*" | "/" | "%") unary)*
  function term() {
    let v = unary();
    while (["*", "/", "%"].includes(peek())) {
      const op = take();
      const r = unary();
      if (op !== "*" && r === 0)
        throw new Error("division by zero");
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  }
  // unary := ("-" | "+") unary | power      (so -2^2 is -4)
  function unary() {
    if (peek() === "-") { take(); return -unary(); }
    if (peek() === "+") { take(); return unary(); }
    return power();
  }
  // power := primary (("^" | "**") unary)?  (right-associative)
  function power() {
    const base = primary();
    if (peek() === "^" || peek() === "**") {
      take();
      const exp = unary();
      if (Math.abs(exp) > 1000)
        throw new Error("exponent too large");
      return base ** exp;
    }
    return base;
  }
  // primary := number | "(" expr ")"
  function primary() {
    const t = take();
    if (t === "(") {
      const v = expr();
      if (take() !== ")")
        throw new Error("missing )");
      return v;
    }
    if (t === undefined || !/^[\d.]/.test(t))
      throw new Error("expected a number");
    return parseFloat(t);
  }

  const v = expr();
  if (i !== tokens.length)
    throw new Error("trailing input");
  return v;
}

/** The formatted result of `text` if it is a sum, else null. */
export function calculate(text) {
  const expression = text.trim().replace(/^=/, "")
    .replace(/×/g, "*").replace(/÷/g, "/").replace(/,/g, "");
  if (!ALLOWED.test(expression) || !HAS_OPERATOR.test(expression))
    return null;
  let value;
  try {
    value = parse(tokenize(expression));
  } catch {
    return null;
  }
  if (!Number.isFinite(value))
    return null;
  if (Number.isInteger(value) && Math.abs(value) < 1e16)
    return value.toLocaleString("en-US");
  return String(parseFloat(value.toPrecision(10)));
}
