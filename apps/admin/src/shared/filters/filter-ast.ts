export type AstNode = Record<string, unknown>;

/**
 * Whether a value is a node rather than a leaf. An array is a compound's children and a
 * RegExp is a matched value, so neither is one. Narrowing through this is what keeps the
 * rest of the engine reading `node.$and` and `node.$ne` without asserting a shape.
 */
export function isAstNode(value: unknown): value is AstNode {
    return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof RegExp);
}

/** The children of a compound node, or null when this isn't one. */
export function getCompoundChildren(node: AstNode, operator: '$and' | '$or'): AstNode[] | null {
    const children = node[operator];

    if (!Array.isArray(children) || !children.every(isAstNode)) {
        return null;
    }

    return children;
}

/**
 * The string a `{$ne: '…'}` clause negates, or null for any other shape. The one negation
 * form this engine emits, read back without asserting the object's shape.
 */
export function readNegatedString(value: unknown): string | null {
    if (!isAstNode(value)) {
        return null;
    }

    return typeof value.$ne === 'string' ? value.$ne : null;
}

export function extractFieldName(node: AstNode): string | undefined {
    const keys = Object.keys(node);

    if (keys.length !== 1) {
        return undefined;
    }

    const [field] = keys;

    if (field.startsWith('$')) {
        return undefined;
    }

    return field;
}

/**
 * What a clause's value says: `{$ne: 'x'}` is an operator and a value, a bare `'x'` is
 * equality. Split out from `extractComparator` because a field named in the value position
 * has a clause value to read but no key to read it from.
 */
export function toComparator(value: unknown): {operator: string; value: unknown} | undefined {
    if (isAstNode(value)) {
        const entries = Object.entries(value);

        if (entries.length !== 1) {
            return undefined;
        }

        const [operator, comparatorValue] = entries[0];
        return {operator, value: comparatorValue};
    }

    return {
        operator: '$eq',
        value
    };
}

export function extractComparator(node: AstNode): {field: string; operator: string; value: unknown} | undefined {
    const field = extractFieldName(node);

    if (!field) {
        return undefined;
    }

    const comparator = toComparator(node[field]);

    if (!comparator) {
        return undefined;
    }

    return {field, ...comparator};
}
