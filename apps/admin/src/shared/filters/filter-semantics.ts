import {DATE_FILTER_OPERATORS} from './filter-date';
import {escapeNqlString} from '@tryghost/nql-string';
import {formatDateInTimezone, getDayBoundsInUtc} from './filter-normalization';
import {isAstNode} from './filter-ast';
import type {CodecContext} from './filter-types';

// What a data type means, with no knowledge of what names it.
//
// A filter clause is a key and an expression: `email:~'ghost'` names a column, and
// `custom_fields.value:~'ghost'` names a relation's value column, but `~'ghost'` means
// "contains ghost" in both. That expression, and reading it back, is all this file does.
// Which key it hangs off is the addressing's problem (see filter-addressing.ts).
//
// A semantics supports its type's whole vocabulary; a field advertises the subset it
// offers through `FilterField.operators`, which is what the picker shows and what
// `isPredicateEnabled` gates on. That is the seam that lets a custom text field offer
// `is-not` while member name does not, without either owning a second implementation.

/** An nql comparator: the operator and value `extractComparator` reads out of a node. */
export interface ValueComparator {
    operator: string;
    value: unknown;
}

/** A predicate's operator and values, minus anything the addressing owns. */
export interface SemanticValue {
    operator: string;
    values: unknown[];
}

export interface ValueSemantics {
    /** The NQL expression following `key:`, or null when this operator and value can't be expressed. */
    serialize: (input: SemanticValue, ctx: CodecContext) => string | null;
    /** A comparator read back into a predicate operator and values, or null for a shape this doesn't emit. */
    parse: (comparator: ValueComparator, ctx: CodecContext) => SemanticValue | null;
}

export interface ValueConfig {
    quoteStrings?: boolean;
    serializeSingletonAsScalar?: boolean;
}

type DateOperator = typeof DATE_FILTER_OPERATORS[number];

const SCALAR_OPERATORS: Record<string, string> = {
    $eq: 'is',
    $ne: 'is-not'
};

const NUMBER_OPERATORS: Record<string, string> = {
    $eq: 'is',
    $gt: 'is-greater',
    $gte: 'is-or-greater',
    $lt: 'is-less',
    $lte: 'is-or-less'
};

const DATE_OPERATORS: Record<string, DateOperator> = {
    $lt: 'is-less',
    $lte: 'is-or-less',
    $gt: 'is-greater',
    $gte: 'is-or-greater'
};

const TEXT_OPERATOR_SYMBOLS: Record<string, string> = {
    contains: '~',
    'does-not-contain': '-~',
    'starts-with': '~^',
    'does-not-start-with': '-~^',
    'ends-with': '~$',
    'does-not-end-with': '-~$'
};

const NUMBER_OPERATOR_SYMBOLS: Record<string, string> = {
    is: '',
    'is-greater': '>',
    'is-or-greater': '>=',
    'is-less': '<',
    'is-or-less': '<='
};

const DATE_OPERATOR_SYMBOLS: Record<string, string> = {
    'is-less': '<',
    'is-or-less': '<=',
    'is-greater': '>',
    'is-or-greater': '>='
};

const SET_OPERATOR_SYMBOLS: Record<string, string> = {
    'is-any': '',
    'is-not-any': '-'
};

const UNQUOTED_TOKEN_PATTERN = /^[A-Za-z0-9_.-]+$/;

function normalizeMultiValue(values: unknown[]): string[] {
    return values.map(value => String(value)).sort((left, right) => left.localeCompare(right));
}

function serializeScalarValue(value: unknown, config?: ValueConfig): string {
    if (typeof value === 'string') {
        if (config?.quoteStrings || value.startsWith('-') || !UNQUOTED_TOKEN_PATTERN.test(value)) {
            return escapeNqlString(value);
        }

        return value;
    }

    return String(value);
}

// A trailing `$` anchors the regex only when it isn't itself escaped: a value holding a
// literal `$` (contains `5$`) reaches here as the source `5\$`, which still ends in `$`.
// An odd run of backslashes before it means it is escaped, so it is part of the value.
// A literal `^` is always escaped to `\^`, so a leading `^` needs no such check.
function hasEndAnchor(source: string): boolean {
    if (!source.endsWith('$')) {
        return false;
    }

    let backslashes = 0;

    for (let index = source.length - 2; index >= 0 && source[index] === '\\'; index -= 1) {
        backslashes += 1;
    }

    return backslashes % 2 === 0;
}

// Which anchors a regex carries, and the value left once they are removed. Read together
// rather than one at a time: the operator and the value are two answers to the same
// question, and deciding the anchors twice is how a value could keep a `$` the operator
// had already consumed.
function decomposeRegex(pattern: RegExp): {anchorStart: boolean; anchorEnd: boolean; value: string} {
    const source = pattern.source;
    const anchorStart = source.startsWith('^');
    const anchorEnd = hasEndAnchor(source);
    const body = source.slice(anchorStart ? 1 : 0, anchorEnd ? -1 : undefined);

    return {
        anchorStart,
        anchorEnd,
        value: body.replace(/\\([\\.^$|?*+()[\]{}/-])/g, '$1')
    };
}

// Anchors read back into the operator that would have produced them. Both anchors is not
// an operator this vocabulary emits, so it falls back to the unanchored reading.
function anchorsToOperator(anchorStart: boolean, anchorEnd: boolean, negated: boolean): string {
    if (anchorStart && !anchorEnd) {
        return negated ? 'does-not-start-with' : 'starts-with';
    }

    if (anchorEnd && !anchorStart) {
        return negated ? 'does-not-end-with' : 'ends-with';
    }

    return negated ? 'does-not-contain' : 'contains';
}

/**
 * Text: the equality pair plus the substring matches. `is` / `is-not` compare the whole
 * value (`$eq` / `$ne`); the rest are regexes whose anchors carry the operator.
 */
export function textSemantics(): ValueSemantics {
    return {
        serialize({operator, values}) {
            const rawValue = values[0];

            if (typeof rawValue !== 'string' || rawValue === '') {
                return null;
            }

            if (operator === 'is') {
                return escapeNqlString(rawValue);
            }

            if (operator === 'is-not') {
                return `-${escapeNqlString(rawValue)}`;
            }

            const symbol = TEXT_OPERATOR_SYMBOLS[operator];

            if (!symbol) {
                return null;
            }

            return `${symbol}${escapeNqlString(rawValue)}`;
        },
        parse({operator, value}) {
            if (operator === '$eq' && typeof value === 'string') {
                return {operator: 'is', values: [value]};
            }

            if (operator === '$ne' && typeof value === 'string') {
                return {operator: 'is-not', values: [value]};
            }

            if ((operator === '$regex' || operator === '$not') && value instanceof RegExp) {
                const {anchorStart, anchorEnd, value: text} = decomposeRegex(value);

                return {
                    operator: anchorsToOperator(anchorStart, anchorEnd, operator === '$not'),
                    values: [text]
                };
            }

            return null;
        }
    };
}

/**
 * A single value compared for equality, quoted only when it has to be.
 */
export function scalarSemantics(config?: ValueConfig): ValueSemantics {
    return {
        serialize({operator, values}) {
            const value = values[0];

            if (value === undefined || value === null || value === '') {
                return null;
            }

            if (operator === 'is') {
                return serializeScalarValue(value, config);
            }

            if (operator === 'is-not') {
                return `-${serializeScalarValue(value, config)}`;
            }

            return null;
        },
        parse({operator, value}) {
            const parsed = SCALAR_OPERATORS[operator];

            if (!parsed) {
                return null;
            }

            return {operator: parsed, values: [value]};
        }
    };
}

/**
 * Membership in a list. Values are sorted on the way out so the same selection always
 * produces the same filter string.
 */
export function setSemantics(config?: ValueConfig): ValueSemantics {
    return {
        serialize({operator, values}) {
            if (!values.length) {
                return null;
            }

            const symbol = SET_OPERATOR_SYMBOLS[operator];

            if (symbol === undefined) {
                return null;
            }

            const sorted = normalizeMultiValue(values);

            if (config?.serializeSingletonAsScalar && sorted.length === 1) {
                return `${symbol}${serializeScalarValue(sorted[0], config)}`;
            }

            return `${symbol}[${sorted.map(value => serializeScalarValue(value, config)).join(',')}]`;
        },
        parse({operator, value}) {
            if (operator === '$in' && Array.isArray(value)) {
                return {operator: 'is-any', values: value};
            }

            if (operator === '$nin' && Array.isArray(value)) {
                return {operator: 'is-not-any', values: value};
            }

            if (operator === '$eq') {
                return {operator: 'is-any', values: [value]};
            }

            if (operator === '$ne') {
                return {operator: 'is-not-any', values: [value]};
            }

            return null;
        }
    };
}

/**
 * Numeric comparison, including the ranges a text field has no use for.
 */
export function numberSemantics(): ValueSemantics {
    return {
        serialize({operator, values}) {
            const rawValue = values[0];
            const value = typeof rawValue === 'string'
                ? rawValue.trim() === ''
                    ? NaN
                    : Number(rawValue)
                : rawValue;

            if (typeof value !== 'number' || Number.isNaN(value)) {
                return null;
            }

            const symbol = NUMBER_OPERATOR_SYMBOLS[operator];

            if (symbol === undefined) {
                return null;
            }

            return `${symbol}${value}`;
        },
        parse({operator, value}) {
            if (typeof value !== 'number') {
                return null;
            }

            const parsed = NUMBER_OPERATORS[operator];

            if (!parsed) {
                return null;
            }

            return {operator: parsed, values: [value]};
        }
    };
}

interface RelativeDateTag {
    $relativeDate: {
        op: 'sub' | 'add';
        amount: number;
        unit: string;
    };
}

function isRelativeDateTag(value: unknown): value is RelativeDateTag {
    if (!isAstNode(value)) {
        return false;
    }

    const tag = value.$relativeDate;

    if (!isAstNode(tag)) {
        return false;
    }

    const {op, amount, unit} = tag;

    return (op === 'sub' || op === 'add')
        && typeof amount === 'number' && Number.isSafeInteger(amount) && amount > 0
        && typeof unit === 'string';
}

/**
 * Dates, absolute and relative. An absolute date names a day, so it serializes to that
 * day's bound in the site timezone — which end depends on the operator.
 */
export function dateSemantics(): ValueSemantics {
    return {
        serialize({operator, values}, ctx) {
            if (operator === 'in-the-last' || operator === 'in-the-next') {
                const days = values[0];

                if (typeof days !== 'number' || !Number.isSafeInteger(days) || days <= 0) {
                    return null;
                }

                const sign = operator === 'in-the-last' ? '-' : '+';
                const symbol = operator === 'in-the-last' ? '>=' : '<=';

                return `${symbol}now${sign}${days}d`;
            }

            const rawValue = values[0];

            if (typeof rawValue !== 'string' || rawValue === '') {
                return null;
            }

            const value = formatDateInTimezone(rawValue, ctx.timezone);

            if (!value) {
                return null;
            }

            const {start, end} = getDayBoundsInUtc(value, ctx.timezone);
            const symbol = DATE_OPERATOR_SYMBOLS[operator];

            if (symbol === undefined) {
                return null;
            }

            const boundary = operator === 'is-less' || operator === 'is-or-greater'
                ? start
                : end;

            return `${symbol}'${boundary}'`;
        },
        parse({operator, value}, ctx) {
            // Relative dates flow through as `{$gte: {$relativeDate: ...}}` when the parse
            // caller opted in via `preserveRelativeDates: true` — we currently only render
            // relative day counts in the UI, so any other unit (weeks, months, ...) falls
            // through to absolute-date handling below.
            if (isRelativeDateTag(value) && value.$relativeDate.unit === 'days') {
                const {op, amount} = value.$relativeDate;
                const isPast = op === 'sub' && operator === '$gte';
                const isFuture = op === 'add' && operator === '$lte';

                if (isPast || isFuture) {
                    return {
                        operator: isPast ? 'in-the-last' : 'in-the-next',
                        values: [amount]
                    };
                }
            }

            if (typeof value !== 'string') {
                return null;
            }

            const parsed = DATE_OPERATORS[operator];
            const formatted = formatDateInTimezone(value, ctx.timezone);

            if (!parsed || !formatted) {
                return null;
            }

            return {operator: parsed, values: [formatted]};
        }
    };
}
