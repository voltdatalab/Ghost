import type {AstNode} from './filter-ast';

export interface FilterPredicate {
    id: string;
    field: string;
    operator: string;
    values: unknown[];
}

export type ParsedPredicate = Omit<FilterPredicate, 'id'>;

export interface CodecContext {
    key: string;
    pattern: string;
    params: Record<string, string>;
    timezone: string;
}

export interface FilterCodec {
    parse: (node: AstNode, ctx: CodecContext) => ParsedPredicate | null;
    serialize: (predicate: FilterPredicate, ctx: CodecContext) => string[] | null;
    /**
     * A grouped node whose field key is carried in a clause value rather than the node's
     * key, so the key-based dispatch cannot route it. Tried before that dispatch, and it
     * names the predicate's field itself.
     */
    parseCompound?: (node: AstNode, ctx: CodecContext) => ParsedPredicate | null;
}

export interface FilterField {
    operators: readonly string[];
    parseKeys?: readonly string[];
    ui: {
        label: string;
        type: 'text' | 'select' | 'multiselect' | 'date' | 'number' | 'custom';
        [key: string]: unknown;
    };
    options?: Array<{value: string; label: string}>;
    metadata?: {
        activeColumn?: {
            key: string;
            label: string;
            include?: string;
        };
    };
    codec: FilterCodec;
}

export function defineFields<TFields extends Record<string, FilterField>>(fields: TFields): TFields {
    return fields;
}
