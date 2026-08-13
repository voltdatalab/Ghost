import {escapeNqlString} from '@tryghost/nql-string';
import {getCompoundChildren, readNegatedString, toComparator} from '@/shared/filters';
import type {CompoundMatch, FieldAddressing} from '@/shared/filters';

// The grammar a member custom field is filtered through, in one place for both directions.
//
//   (custom_fields.key:'company'+custom_fields.value:'Ghost')                // a value
//   (custom_fields.key:'shipping_address'+custom_fields.value.country:'GB')  // a part's value
//   custom_fields.key:'phone'  /  custom_fields.key:-'phone'                 // field set / not set
//   (custom_fields.key:'shipping_address'+custom_fields.path:'country')      // part set / not set
//
// The field is named in the value position rather than the key position, because a field
// key may hold characters NQL's key position will not take. That is the whole reason this
// needs an addressing of its own; what the value *means* is ordinary text comparison, and
// comes from the shared vocabulary. Ghost core reads the same grammar back into an
// `$elemMatch` over the values table — see services/members-custom-fields/filter.ts.

const RELATION = 'custom_fields';
const KEY_ATTRIBUTE = `${RELATION}.key`;
const VALUE_ATTRIBUTE = `${RELATION}.value`;
const PATH_ATTRIBUTE = `${RELATION}.path`;

/** Predicates are keyed by the field's stable key, so the picker entry and the filter agree. */
export const CUSTOM_FIELD_KEY_PREFIX = 'custom_field.';

// Presence: the extra an optional, per-member field has that a table column does not. A
// column is always set, so no column-backed field offers these.
export const CUSTOM_FIELD_SET_OPERATORS: readonly string[] = ['is-set', 'is-not-set'];

function keyClause(fieldKey: string): string {
    return `${KEY_ATTRIBUTE}:${escapeNqlString(fieldKey)}`;
}

/**
 * A predicate carries `[subfield, value]`: the part of a composite field being filtered
 * (empty for a scalar field, or for the whole-field presence case), then the value itself.
 * Read rather than asserted, so a predicate that has lost its shape resolves to the
 * whole-field case instead of reaching NQL as `undefined`.
 */
function readValues(values: unknown[]): {subfield: string; value: unknown} {
    const [subfield, value] = values;

    return {
        subfield: typeof subfield === 'string' ? subfield : '',
        value
    };
}

/**
 * The subfield belongs to the addressing, the value to the semantics.
 */
export function customFieldAddressing(): FieldAddressing {
    return {
        presenceOperators: CUSTOM_FIELD_SET_OPERATORS,

        address(predicate, ctx) {
            const fieldKey = ctx.params.key;
            const {subfield, value} = readValues(predicate.values);

            if (!fieldKey) {
                return null;
            }

            return {
                valueKey: subfield ? `${VALUE_ATTRIBUTE}.${subfield}` : VALUE_ATTRIBUTE,
                companions: [keyClause(fieldKey)],
                values: [value]
            };
        },

        // set / not-set target a part's presence when a part is chosen (`path`), or the whole
        // field otherwise (the bare key clause, or its negation).
        addressPresence(predicate, ctx) {
            const fieldKey = ctx.params.key;
            const {subfield} = readValues(predicate.values);

            if (!fieldKey) {
                return null;
            }

            if (predicate.operator === 'is-set') {
                return subfield
                    ? [`(${keyClause(fieldKey)}+${PATH_ATTRIBUTE}:${escapeNqlString(subfield)})`]
                    : [keyClause(fieldKey)];
            }

            return subfield
                ? [`(${keyClause(fieldKey)}+${PATH_ATTRIBUTE}:-${escapeNqlString(subfield)})`]
                : [`${KEY_ATTRIBUTE}:-${escapeNqlString(fieldKey)}`];
        },

        // A custom field never arrives as a node the key dispatch can route, because the key
        // it would dispatch on (`custom_fields.value`) names no field on its own.
        match() {
            return null;
        },

        matchCompound(node): CompoundMatch | null {
            const children = getCompoundChildren(node, '$and');

            if (!children) {
                const keyValue = node[KEY_ATTRIBUTE];

                if (typeof keyValue === 'string') {
                    return {kind: 'predicate', predicate: {field: `${CUSTOM_FIELD_KEY_PREFIX}${keyValue}`, operator: 'is-set', values: ['', '']}};
                }

                const negatedKey = readNegatedString(keyValue);

                if (negatedKey !== null) {
                    return {kind: 'predicate', predicate: {field: `${CUSTOM_FIELD_KEY_PREFIX}${negatedKey}`, operator: 'is-not-set', values: ['', '']}};
                }

                return null;
            }

            if (children.length !== 2) {
                return null;
            }

            let fieldKey: string | undefined;
            let valueEntry: {subfield: string; raw: unknown} | undefined;
            let pathEntry: {subfield: string; negated: boolean} | undefined;

            for (const child of children) {
                if (typeof child[KEY_ATTRIBUTE] === 'string') {
                    fieldKey = child[KEY_ATTRIBUTE];
                }

                for (const childKey of Object.keys(child)) {
                    if (childKey === VALUE_ATTRIBUTE) {
                        valueEntry = {subfield: '', raw: child[childKey]};
                    } else if (childKey.startsWith(`${VALUE_ATTRIBUTE}.`)) {
                        valueEntry = {subfield: childKey.slice(`${VALUE_ATTRIBUTE}.`.length), raw: child[childKey]};
                    } else if (childKey === PATH_ATTRIBUTE) {
                        const raw = child[childKey];
                        const negatedPath = readNegatedString(raw);

                        if (typeof raw === 'string') {
                            pathEntry = {subfield: raw, negated: false};
                        } else if (negatedPath !== null) {
                            pathEntry = {subfield: negatedPath, negated: true};
                        }
                    }
                }
            }

            if (!fieldKey) {
                return null;
            }

            // A `path` clause is a part's set / not-set: its presence, carrying no value.
            if (pathEntry) {
                return {
                    kind: 'predicate',
                    predicate: {
                        field: `${CUSTOM_FIELD_KEY_PREFIX}${fieldKey}`,
                        operator: pathEntry.negated ? 'is-not-set' : 'is-set',
                        values: [pathEntry.subfield, '']
                    }
                };
            }

            if (!valueEntry) {
                return null;
            }

            const comparator = toComparator(valueEntry.raw);

            if (!comparator) {
                return null;
            }

            return {
                kind: 'value',
                field: `${CUSTOM_FIELD_KEY_PREFIX}${fieldKey}`,
                leadingValues: [valueEntry.subfield],
                comparator
            };
        }
    };
}
