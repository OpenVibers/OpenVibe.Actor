'use strict';

/**
 * A tool's `args` as the JSON Schema subset actor.skill@2 declares (ADR-060): an object whose properties are
 * string, number, integer, boolean or an array of those, with enum, maxLength, pattern (≤ 200 characters), minItems
 * and maxItems; no $ref, no nested object. The model's tool call is checked against it BEFORE Actor submits anything:
 * a bad input never becomes a Run job, so the person's approval card and the job body only ever carry a valid call.
 *
 *   validate(schema, input) → { ok: true, value } | { ok: false, error }
 */
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function valueError(schema, value, path) {
    const type = schema && schema.type;
    if (type === 'string') {
        if (typeof value !== 'string') return `${path} must be a string.`;
        if (schema.maxLength != null && value.length > schema.maxLength) return `${path} is longer than ${schema.maxLength} characters.`;
        if (schema.pattern != null) {
            let re;
            try { re = new RegExp(schema.pattern); } catch { return `${path} has a pattern that is not a regular expression.`; }
            if (!re.test(value)) return `${path} does not match the tool's pattern.`;
        }
    } else if (type === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value)) return `${path} must be a number.`;
    } else if (type === 'integer') {
        if (typeof value !== 'number' || !Number.isInteger(value)) return `${path} must be an integer.`;
    } else if (type === 'boolean') {
        if (typeof value !== 'boolean') return `${path} must be true or false.`;
    } else if (type === 'array') {
        if (!Array.isArray(value)) return `${path} must be an array.`;
        if (schema.minItems != null && value.length < schema.minItems) return `${path} has fewer than ${schema.minItems} items.`;
        if (schema.maxItems != null && value.length > schema.maxItems) return `${path} has more than ${schema.maxItems} items.`;
        const itemSchema = isPlain(schema.items) ? schema.items : null;
        if (!itemSchema) return `${path} must say what its items are.`;
        for (let i = 0; i < value.length; i++) {
            const why = valueError(itemSchema, value[i], `${path}[${i}]`);
            if (why) return why;
        }
    } else {
        return `${path} is not a shape a tool argument may have.`;
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((x) => x === value)) {
        return `${path} is not one of the values the tool allows (${schema.enum.map((x) => JSON.stringify(x)).slice(0, 8).join(', ')}).`;
    }
    return null;
}

function validate(schema, input) {
    if (!isPlain(schema) || schema.type !== 'object') return { ok: false, error: 'The tool does not declare an object input.' };
    if (!isPlain(input)) return { ok: false, error: 'The tool input must be an object.' };
    const props = isPlain(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
        if (!Object.prototype.hasOwnProperty.call(input, key)) return { ok: false, error: `The tool needs ${JSON.stringify(key)}.` };
    }
    for (const key of Object.keys(input)) {
        if (!Object.prototype.hasOwnProperty.call(props, key)) {
            if (schema.additionalProperties === false) return { ok: false, error: `The tool does not take ${JSON.stringify(key)}.` };
            continue;
        }
        const why = valueError(props[key], input[key], JSON.stringify(key));
        if (why) return { ok: false, error: why };
    }
    return { ok: true, value: input };
}

module.exports = { validate, valueError };
