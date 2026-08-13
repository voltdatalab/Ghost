import {extractComparator} from './filter-ast';
import type {AstNode} from './filter-ast';
import type {CodecContext, FilterCodec, FilterPredicate, ParsedPredicate} from './filter-types';
import type {SemanticValue, ValueComparator, ValueSemantics} from './filter-semantics';

// How a field names its value, with no knowledge of what that value means.
//
// Most fields are a column: the field's key is the NQL key, and the whole clause is
// `key:<expression>`. A field reached through a relation is not — a member custom field
// is named in the *value* position, because its key may hold characters the key position
// cannot, so one predicate becomes a pair of clauses:
//
//   name:~'ghost'                                              // column
//   (custom_fields.key:'company'+custom_fields.value:~'ghost') // relation
//
// Both carry the same `~'ghost'`. Splitting the two apart is what lets a new field type
// pick a vocabulary from filter-semantics.ts and a grammar from here, instead of writing
// a third copy of both.

/** Where a predicate's value goes, and what is left for the semantics to express. */
export interface FieldAddress {
    /** The NQL key the value expression hangs off. */
    valueKey: string;
    /** Clauses that must accompany it to name the field, grouped with it when present. */
    companions?: string[];
    /** The values the semantics should serialize — the predicate's, minus what the addressing owns. */
    values: unknown[];
}

/** A node recognised as this field's, and the comparator carrying its value. */
export interface MatchedValue {
    comparator: ValueComparator;
    /** The predicate field key, when the addressing determines it rather than the context. */
    field?: string;
    /** Values the addressing contributes, prepended to the semantics' values. */
    leadingValues?: unknown[];
}

/**
 * A node this addressing recognises: either a complete predicate it answers alone
 * (presence, which has no value to interpret), or a value for the semantics to read.
 */
export type CompoundMatch =
    | {kind: 'predicate'; predicate: ParsedPredicate}
    | ({kind: 'value'} & MatchedValue);

export interface FieldAddressing {
    address: (predicate: FilterPredicate, ctx: CodecContext) => FieldAddress | null;
    match: (node: AstNode, ctx: CodecContext) => MatchedValue | null;
    /**
     * Operators the addressing expresses on its own, with no value expression. A column is
     * always set, so only a relation has these — whether a row exists at all.
     */
    presenceOperators?: readonly string[];
    addressPresence?: (predicate: FilterPredicate, ctx: CodecContext) => string[] | null;
    /**
     * A node whose field key is not the node's key, so the key-based dispatch in
     * filter-query-core.ts cannot route it here. Consulted before that dispatch.
     */
    matchCompound?: (node: AstNode) => CompoundMatch | null;
}

/** Clauses joined into one filter term, grouped only when there is more than one. */
function combine(clauses: string[]): string {
    if (clauses.length === 1) {
        return clauses[0];
    }

    return `(${clauses.join('+')})`;
}

/**
 * The default: the field's key is the NQL key. `config.field` renames it for a field whose
 * predicate key and NQL key differ.
 */
export function columnAddressing(config?: {field?: string}): FieldAddressing {
    const keyFor = (ctx: CodecContext) => config?.field ?? ctx.key;

    return {
        address(predicate, ctx) {
            return {valueKey: keyFor(ctx), values: predicate.values};
        },
        match(node, ctx) {
            const comparator = extractComparator(node);

            if (!comparator || comparator.field !== keyFor(ctx)) {
                return null;
            }

            return {comparator: {operator: comparator.operator, value: comparator.value}};
        }
    };
}

function toPredicate(matched: MatchedValue, parsed: SemanticValue, ctx: CodecContext): ParsedPredicate {
    return {
        field: matched.field ?? ctx.key,
        operator: parsed.operator,
        values: [...(matched.leadingValues ?? []), ...parsed.values]
    };
}

/**
 * One grammar plus one vocabulary makes a codec. Everything either side knows stays on its
 * own side: the addressing never inspects an operator it hasn't claimed as presence, and
 * the semantics never sees a field name.
 */
export function composeCodec(addressing: FieldAddressing, semantics: ValueSemantics): FilterCodec {
    return {
        parse(node, ctx) {
            const matched = addressing.match(node, ctx);

            if (!matched) {
                return null;
            }

            const parsed = semantics.parse(matched.comparator, ctx);

            if (!parsed) {
                return null;
            }

            return toPredicate(matched, parsed, ctx);
        },
        serialize(predicate, ctx) {
            if (addressing.presenceOperators?.includes(predicate.operator)) {
                return addressing.addressPresence?.(predicate, ctx) ?? null;
            }

            const address = addressing.address(predicate, ctx);

            if (!address) {
                return null;
            }

            const expression = semantics.serialize({operator: predicate.operator, values: address.values}, ctx);

            if (expression === null) {
                return null;
            }

            return [combine([...(address.companions ?? []), `${address.valueKey}:${expression}`])];
        },
        parseCompound: addressing.matchCompound
            ? (node, ctx) => {
                const matched = addressing.matchCompound?.(node);

                if (!matched) {
                    return null;
                }

                if (matched.kind === 'predicate') {
                    return matched.predicate;
                }

                const parsed = semantics.parse(matched.comparator, ctx);

                if (!parsed) {
                    return null;
                }

                return toPredicate(matched, parsed, ctx);
            }
            : undefined
    };
}
