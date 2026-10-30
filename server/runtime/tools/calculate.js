'use strict';
/**
 * calculate: exact arithmetic and unit conversion, offline.
 *
 * The expression is parsed by the small parser below - never by eval, never by Function, never
 * by a child process - so an expression can only ever be arithmetic: numbers, + - * / % ^, brackets,
 * a fixed list of functions and a fixed list of constants. Integer arithmetic stays exact (BigInt)
 * from end to end; anything with a decimal point is a double.
 *
 * A question that also carries units ("10 km to miles", "72 F to C") is answered as a conversion
 * from the table below. The factors are the international ones (1 mile = 1609.344 m, 1 pound =
 * 0.45359237 kg, and so on); a month and a year are the mean Gregorian ones.
 */
const { ToolError, round, group, source, fail } = require('./lib/util');

const CONSTANTS = {
    pi: Math.PI,
    e: Math.E,
    tau: Math.PI * 2,
};

const FUNCTIONS = {
    sqrt: (a) => {
        if (Number(a) < 0) throw new ToolError('the square root of a negative number is not a real number');
        return Math.sqrt(Number(a));
    },
    abs: (a) => (typeof a === 'bigint' ? (a < 0n ? -a : a) : Math.abs(Number(a))),
    round: (a, d) => {
        const places = d === undefined ? 0 : Math.round(Number(d));
        const p = Math.pow(10, places);
        return Math.round(Number(a) * p) / p;
    },
    floor: (a) => (typeof a === 'bigint' ? a : Math.floor(Number(a))),
    ceil: (a) => (typeof a === 'bigint' ? a : Math.ceil(Number(a))),
    trunc: (a) => (typeof a === 'bigint' ? a : Math.trunc(Number(a))),
    sign: (a) => Math.sign(Number(a)),
    min: (...args) => Math.min(...args.map(Number)),
    max: (...args) => Math.max(...args.map(Number)),
    pow: (a, b) => Math.pow(Number(a), Number(b)),
    hypot: (...args) => Math.hypot(...args.map(Number)),
    log: (a) => Math.log10(Number(a)),
    log2: (a) => Math.log2(Number(a)),
    ln: (a) => Math.log(Number(a)),
    exp: (a) => Math.exp(Number(a)),
    sin: (a) => Math.sin(Number(a)),
    cos: (a) => Math.cos(Number(a)),
    tan: (a) => Math.tan(Number(a)),
    asin: (a) => Math.asin(Number(a)),
    acos: (a) => Math.acos(Number(a)),
    atan: (a) => Math.atan(Number(a)),
    sinh: (a) => Math.sinh(Number(a)),
    cosh: (a) => Math.cosh(Number(a)),
    tanh: (a) => Math.tanh(Number(a)),
    deg: (a) => (Number(a) * 180) / Math.PI,
    rad: (a) => (Number(a) * Math.PI) / 180,
    gcd: (...args) => {
        let a = BigInt(args[0]);
        let b = BigInt(args[1]);
        if (a < 0n) a = -a;
        if (b < 0n) b = -b;
        while (b) { const t = a % b; a = b; b = t; }
        return a;
    },
    lcm: (...args) => {
        const a = BigInt(args[0]);
        const b = BigInt(args[1]);
        const g = (x, y) => { let p = x < 0n ? -x : x; let q = y < 0n ? -y : y; while (q) { const t = p % q; p = q; q = t; } return p; };
        if (a === 0n || b === 0n) return 0n;
        return (a / g(a, b)) * b;
    },
    fact: (a) => {
        const n = Number(a);
        if (!Number.isInteger(n) || n < 0) throw new ToolError('the factorial is only defined for whole numbers of 0 or more');
        let out = 1n;
        for (let i = 2n; i <= BigInt(n); i += 1n) out *= i;
        return out;
    },
};

const ARG_COUNT = {
    sqrt: 1, abs: 1, round: [1, 2], floor: 1, ceil: 1, trunc: 1, sign: 1, pow: 2,
    min: [1, 8], max: [1, 8], hypot: [2, 8], log: 1, log2: 1, ln: 1, exp: 1,
    sin: 1, cos: 1, tan: 1, asin: 1, acos: 1, atan: 1, sinh: 1, cosh: 1, tanh: 1,
    deg: 1, rad: 1, gcd: 2, lcm: 2, fact: 1,
};

/** The units this tool knows, by kind. The factor turns a unit into the kind's base unit. */
const UNIT_TABLE = (() => {
    const table = {};
    const add = (kind, entries) => {
        for (const [names, factor] of entries) {
            for (const name of names.split(' ')) table[name] = { kind, factor };
        }
    };
    add('length', [
        ['m m meter meters metre metres', 1],
        ['km kilometer kilometers kilometre kilometres', 1000],
        ['cm centimeter centimeters centimetre centimetres', 0.01],
        ['mm millimeter millimeters millimetre millimetres', 0.001],
        ['um micrometer micrometers micrometre micrometres', 1e-6],
        ['nm nanometer nanometers', 1e-9],
        ['mi mile miles', 1609.344],
        ['yd yard yards', 0.9144],
        ['ft foot feet', 0.3048],
        ['in inch inches', 0.0254],
        ['nmi nauticalmile nauticalmiles', 1852],
        ['ly lightyear lightyears', 9.4607304725808e15],
        ['au astronomicunit', 1.495978707e11],
    ]);
    add('mass', [
        ['kg kilogram kilograms kilogramme kilogrammes', 1],
        ['g gram grams gramme grammes', 0.001],
        ['mg milligram milligrams', 1e-6],
        ['t tonne tonnes metricton', 1000],
        ['lb lbs pound pounds', 0.45359237],
        ['oz ounce ounces', 0.028349523125],
        ['st stone stones', 6.35029318],
    ]);
    add('time', [
        ['s sec secs second seconds', 1],
        ['min mins minute minutes', 60],
        ['h hr hrs hour hours', 3600],
        ['day days', 86400],
        ['week weeks', 604800],
        ['fortnight fortnights', 1209600],
        ['month months', 2629746],
        ['year years yr yrs', 31556952],
    ]);
    add('volume', [
        ['l l liter liters litre litres', 1],
        ['ml milliliter milliliters millilitre millilitres', 0.001],
        ['m3 cubicmeter cubicmetre', 1000],
        ['cm3 cubiccentimeter', 0.001],
        ['gal gallon gallons', 3.785411784],
        ['qt quart quarts', 0.946352946],
        ['pt pint pints', 0.473176473],
        ['floz fluidounce', 0.0295735295625],
        ['cup cups', 0.2365882365],
    ]);
    add('area', [
        ['m2 sqm squaremeter', 1],
        ['km2 sqkm squarekilometer', 1e6],
        ['cm2 sqcm', 1e-4],
        ['ha hectare hectares', 10000],
        ['acre acres', 4046.8564224],
        ['ft2 sqft', 0.09290304],
        ['yd2 sqyd', 0.83612736],
        ['mi2 sqmi', 2589988.110336],
    ]);
    add('speed', [
        ['mps', 1],
        ['kmh kph', 1 / 3.6],
        ['mph', 0.44704],
        ['kn knot knots', 0.5144444444444445],
        ['fps', 0.3048],
    ]);
    add('pressure', [
        ['pa pascal pascals', 1],
        ['kpa kilopascal', 1000],
        ['mpa megapascal', 1e6],
        ['bar bars', 100000],
        ['mbar millibar', 100],
        ['psi', 6894.757293168361],
        ['atm', 101325],
        ['torr', 133.32236842105263],
        ['mmhg', 133.322387415],
    ]);
    add('energy', [
        ['j joule joules', 1],
        ['kj kilojoule', 1000],
        ['mj megajoule', 1e6],
        ['cal calorie calories', 4.184],
        ['kcal kilocalorie', 4184],
        ['wh watthour', 3600],
        ['kwh kilowatthour', 3.6e6],
        ['btu', 1055.05585262],
        ['ftlb', 1.3558179483314004],
    ]);
    add('power', [
        ['w watt watts', 1],
        ['kw kilowatt kilowatts', 1000],
        ['mw megawatt', 1e6],
        ['hp horsepower', 745.6998715822702],
    ]);
    add('data', [
        ['b byte bytes', 1],
        ['kb kilobyte', 1000],
        ['mb megabyte', 1e6],
        ['gb gigabyte', 1e9],
        ['tb terabyte', 1e12],
        ['kib kibibyte', 1024],
        ['mib mebibyte', 1048576],
        ['gib gibibyte', 1073741824],
        ['tib tebibyte', 1099511627776],
        ['bit bits', 0.125],
    ]);
    add('angle', [
        ['deg degree degrees', 1],
        ['rad radian radians', 57.29577951308232],
        ['grad gradian gradians', 0.9],
    ]);
    add('frequency', [
        ['hz hertz', 1],
        ['khz kilohertz', 1000],
        ['mhz megahertz', 1e6],
        ['ghz gigahertz', 1e9],
    ]);
    return table;
})();

const TEMPERATURE = { c: 'c', celsius: 'c', centigrade: 'c', f: 'f', fahrenheit: 'f', k: 'k', kelvin: 'k' };

const cleanUnit = (unit) => String(unit || '').trim().toLowerCase().replace(/°/g, '').replace(/\s+/g, '');

/** The factor that turns one unit into the base unit of its kind. */
function unitFactor(unit) {
    const name = cleanUnit(unit);
    if (!name) return null;
    if (name.includes('/')) {
        const [top, bottom] = name.split('/');
        const a = unitFactor(top);
        const b = unitFactor(bottom);
        if (!a || !b) return null;
        return { kind: a.kind, factor: a.factor / b.factor };
    }
    if (UNIT_TABLE[name]) return UNIT_TABLE[name];
    return null;
}

const isTemperature = (unit) => Object.prototype.hasOwnProperty.call(TEMPERATURE, cleanUnit(unit));

/** A temperature in Celsius. */
function toCelsius(value, unit) {
    const kind = TEMPERATURE[cleanUnit(unit)];
    if (kind === 'f') return ((value - 32) * 5) / 9;
    if (kind === 'k') return value - 273.15;
    return value;
}

function fromCelsius(celsius, unit) {
    const kind = TEMPERATURE[cleanUnit(unit)];
    if (kind === 'f') return (celsius * 9) / 5 + 32;
    if (kind === 'k') return celsius + 273.15;
    return celsius;
}

/** Split the expression into tokens. */
function tokenize(input) {
    const text = String(input);
    const tokens = [];
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === ' ' || ch === '\t' || ch === '\n') { i += 1; continue; }
        if (/[0-9.]/.test(ch)) {
            const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(i));
            if (!m) throw new ToolError('unexpected "' + ch + '" in the expression');
            tokens.push({ type: 'number', value: m[0] });
            i += m[0].length;
            continue;
        }
        if (/[A-Za-z_]/.test(ch)) {
            const m = /^[A-Za-z_][A-Za-z_0-9]*/.exec(text.slice(i));
            tokens.push({ type: 'ident', value: m[0] });
            i += m[0].length;
            continue;
        }
        if (text.startsWith('**', i)) { tokens.push({ type: 'op', value: '^' }); i += 2; continue; }
        if ('+-*/%^'.includes(ch)) { tokens.push({ type: 'op', value: ch }); i += 1; continue; }
        if (ch === '(' || ch === ')' || ch === ',') { tokens.push({ type: ch, value: ch }); i += 1; continue; }
        throw new ToolError('unexpected "' + ch + '" in the expression');
    }
    return tokens;
}

/** The parser: expressions become a tree, never code. */
class Parser {
    constructor(tokens) {
        this.tokens = tokens;
        this.pos = 0;
    }

    peek() {
        return this.tokens[this.pos] || null;
    }

    next() {
        const token = this.tokens[this.pos] || null;
        this.pos += 1;
        return token;
    }

    expect(type) {
        const token = this.next();
        if (!token || token.type !== type) throw new ToolError('the expression is not complete');
        return token;
    }

    parse() {
        const node = this.expression();
        if (this.pos < this.tokens.length) throw new ToolError('the expression has something left over');
        return node;
    }

    expression() {
        let left = this.term();
        while (this.peek() && this.peek().type === 'op' && (this.peek().value === '+' || this.peek().value === '-')) {
            const op = this.next().value;
            left = { t: 'bin', op, left, right: this.term() };
        }
        return left;
    }

    term() {
        let left = this.unary();
        while (this.peek() && this.peek().type === 'op' && ['*', '/', '%'].includes(this.peek().value)) {
            const op = this.next().value;
            left = { t: 'bin', op, left, right: this.unary() };
        }
        return left;
    }

    unary() {
        const token = this.peek();
        if (token && token.type === 'op' && (token.value === '+' || token.value === '-')) {
            this.next();
            return { t: 'un', op: token.value, operand: this.unary() };
        }
        return this.power();
    }

    power() {
        const base = this.primary();
        const token = this.peek();
        if (token && token.type === 'op' && token.value === '^') {
            this.next();
            return { t: 'bin', op: '^', left: base, right: this.unary() };
        }
        return base;
    }

    primary() {
        const token = this.next();
        if (!token) throw new ToolError('the expression ends too early');
        if (token.type === 'number') {
            const exact = !/[.eE]/.test(token.value);
            return { t: 'num', text: token.value, exact };
        }
        if (token.type === '(') {
            const inner = this.expression();
            this.expect(')');
            return inner;
        }
        if (token.type === 'ident') {
            const name = token.value.toLowerCase();
            const after = this.peek();
            if (after && after.type === '(') {
                this.next();
                const args = [];
                if (this.peek() && this.peek().type === ')') this.next();
                else {
                    for (;;) {
                        args.push(this.expression());
                        if (this.peek() && this.peek().type === ')') { this.next(); break; }
                        const sep = this.next();
                        if (!sep || sep.type !== ',') throw new ToolError('the arguments of ' + name + ' are not separated');
                    }
                }
                return { t: 'call', name, args };
            }
            if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) return { t: 'const', name };
            throw new ToolError('there is no "' + token.value + '" in this calculator');
        }
        throw new ToolError('unexpected "' + (token.value || token.type) + '" in the expression');
    }
}

/** The tree, evaluated. Whole numbers stay whole. */
function evaluate(node) {
    if (node.t === 'num') return node.exact ? BigInt(node.text) : Number(node.text);
    if (node.t === 'const') return CONSTANTS[node.name];
    if (node.t === 'un') {
        const value = evaluate(node.operand);
        return node.op === '-' ? -value : value;
    }
    if (node.t === 'bin') {
        const left = evaluate(node.left);
        const right = evaluate(node.right);
        return applyOperator(node.op, left, right);
    }
    if (node.t === 'call') {
        const fn = FUNCTIONS[node.name];
        if (!fn) throw new ToolError('there is no function called "' + node.name + '"');
        const args = node.args.map(evaluate);
        const expected = ARG_COUNT[node.name];
        if (expected !== undefined) {
            const min = Array.isArray(expected) ? expected[0] : expected;
            const max = Array.isArray(expected) ? expected[1] : expected;
            if (args.length < min || args.length > max) {
                throw new ToolError(node.name + ' takes ' + (min === max ? min + ' argument' : min + ' to ' + max + ' arguments'));
            }
        }
        return fn(...args);
    }
    throw new ToolError('the expression could not be read');
}

function applyOperator(op, left, right) {
    const bothIntegers = typeof left === 'bigint' && typeof right === 'bigint';
    if (op === '+') return bothIntegers ? left + right : Number(left) + Number(right);
    if (op === '-') return bothIntegers ? left - right : Number(left) - Number(right);
    if (op === '*') return bothIntegers ? left * right : Number(left) * Number(right);
    if (op === '/') {
        if (bothIntegers) {
            if (right === 0n) throw new ToolError('division by zero');
            return left % right === 0n ? left / right : Number(left) / Number(right);
        }
        if (Number(right) === 0) throw new ToolError('division by zero');
        return Number(left) / Number(right);
    }
    if (op === '%') {
        if (bothIntegers) {
            if (right === 0n) throw new ToolError('division by zero');
            return left % right;
        }
        if (Number(right) === 0) throw new ToolError('division by zero');
        return Number(left) % Number(right);
    }
    if (op === '^') {
        if (bothIntegers && right >= 0n && right < 1000n) return left ** right;
        return Math.pow(Number(left), Number(right));
    }
    throw new ToolError('the operator "' + op + '" is not one this calculator knows');
}

/** A result a person can read: whole numbers whole, everything else to twelve useful digits. */
function formatValue(value) {
    if (typeof value === 'bigint') return value.toString();
    if (!Number.isFinite(value)) return String(value);
    if (Number.isInteger(value)) return String(value);
    return String(Number(value.toPrecision(12)));
}

/** "10 km to miles", "72 F to C", "100 kg in pounds": a number, a unit and another unit. */
function parseConversion(expression) {
    const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([^\d\s][^\s]*)?\s+(?:to|in|as|into)\s+([^\d\s][^\s]*)\s*$/i.exec(expression);
    if (!m) return null;
    const value = Number(m[1]);
    if (!Number.isFinite(value)) return null;
    return { value, from: m[2] || null, to: m[3] || null };
}

module.exports = {
    name: 'calculate',
    description: 'Do arithmetic and convert units, offline and exactly. Handles + - * / % ^, brackets, whole-number '
        + 'arithmetic without rounding, functions (sqrt, abs, round, min, max, pow, log, ln, sin, cos, floor, ceil, gcd, '
        + 'lcm, fact, deg, rad), constants (pi, e, tau) and conversions such as "10 km to miles", "72 F to C" or '
        + '"100 kg in pounds". Use it instead of working the arithmetic out in your head.',
    input: {
        type: 'object',
        properties: {
            expression: { type: 'string', description: 'The calculation, for example "((12 + 8) * 3) / 4", "2^10", "sqrt(144) + 2^3" or "10 km to miles".' },
        },
        required: ['expression'],
    },
    scope: 'public',
    costUsd: 0,
    timeoutMs: 5000,
    sources: [source('https://www.nist.gov/pml/owm/si-units', 'NIST: the international system of units')],

    async run(input = {}, ctx = {}) {
        const expression = String(input.expression || '').trim();
        if (!expression) return fail('calculate needs an expression, for example "2 + 2" or "10 km to miles".');
        try {
            const conversion = parseConversion(expression);
            if (conversion && conversion.from && conversion.to) return convert(conversion, expression);
            if (conversion && !conversion.from) {
                return fail('a conversion needs both units, for example "10 km to miles".');
            }
            const tree = new Parser(tokenize(expression)).parse();
            const value = evaluate(tree);
            const exact = typeof value === 'bigint';
            const text = formatValue(value);
            const lines = [expression + ' = ' + text + '.'];
            if (exact) lines.push('The result is exact (whole numbers, no rounding).');
            const small = exact && BigInt(text) <= BigInt(Number.MAX_SAFE_INTEGER) && BigInt(text) >= BigInt(Number.MIN_SAFE_INTEGER);
            return {
                text: lines.join(' '),
                data: {
                    kind: 'expression',
                    expression,
                    value: exact ? (small ? Number(text) : text) : Number(text),
                    value_exact: text,
                    exact,
                    fetched_at: new Date().toISOString(),
                },
                sources: [],
                artifacts: [],
            };
        } catch (err) {
            return fail((err && err.message) || 'the calculation could not be done');
        }
    },
};

function convert(conversion, expression) {
    const from = cleanUnit(conversion.from);
    const to = cleanUnit(conversion.to);
    if (isTemperature(from) && isTemperature(to)) {
        const celsius = toCelsius(conversion.value, from);
        const result = fromCelsius(celsius, to);
        return {
            text: conversion.value + ' ' + conversion.from + ' = ' + round(result, 6) + ' ' + conversion.to + '.',
            data: {
                kind: 'conversion',
                expression,
                value: round(result, 6),
                from: conversion.from,
                to: conversion.to,
                exact: false,
                fetched_at: new Date().toISOString(),
            },
            sources: [source('https://www.nist.gov/pml/owm/si-units', 'NIST: the international system of units')],
            artifacts: [],
        };
    }
    const a = unitFactor(from);
    const b = unitFactor(to);
    if (!a || !b) {
        return fail('this tool does not know "' + (a ? conversion.to : conversion.from) + '". It knows metres, kilometres, miles, feet, kilograms, pounds, seconds, hours, days, litres, gallons, m/s, km/h, mph, pascals, bar, psi, joules, calories, watts, bytes and degrees.');
    }
    if (a.kind !== b.kind) {
        return fail('a ' + conversion.from + ' is not a ' + conversion.to + ' (one is a ' + a.kind + ', the other a ' + b.kind + ').');
    }
    const base = conversion.value * a.factor;
    const result = base / b.factor;
    return {
        text: group(conversion.value) + ' ' + conversion.from + ' = ' + group(round(result, 6)) + ' ' + conversion.to + '.',
        data: {
            kind: 'conversion',
            expression,
            value: round(result, 10),
            from: conversion.from,
            to: conversion.to,
            factor: round(b.factor, 12),
            exact: false,
            fetched_at: new Date().toISOString(),
        },
        sources: [source('https://www.nist.gov/pml/owm/si-units', 'NIST: the international system of units')],
        artifacts: [],
    };
}
