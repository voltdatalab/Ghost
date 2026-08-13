import {type AstNode, type FilterPredicate, type ParsedPredicate, dispatchCompoundNode, dispatchSimpleNodes, getCompoundChildren, getFieldKeysByType, hasFieldKey, parseFilterToAst, readNegatedString, resolveField, serializePredicates, stampPredicates} from '@/shared/filters';
import {memberFields} from './member-fields';
import type {MemberFields} from './member-fields';

type CompoundMatcher = (node: AstNode) => ParsedPredicate | null;
const TIMEZONE_SENSITIVE_MEMBER_FIELDS = getFieldKeysByType(memberFields, 'date');

/**
 * Is this predicate's operator one the field currently advertises?
 *
 * This returns `false` for predicates the user can't reach in the UI because
 * the field never declares the operator. Hooks call this to drop unreachable
 * predicates before serializing or after parsing. The parser/serializer
 * themselves stay pure.
 */
export function isPredicateEnabled(predicate: ParsedPredicate, fields: MemberFields): boolean {
    const resolved = resolveField(fields, predicate.field, 'UTC');
    return resolved?.definition.operators.includes(predicate.operator) ?? false;
}

function getCompound(node: AstNode): {operator: '$and' | '$or'; children: AstNode[]} | null {
    for (const operator of ['$and', '$or'] as const) {
        const children = getCompoundChildren(node, operator);

        if (children) {
            return {operator, children};
        }
    }

    return null;
}

function matchSubscribedNode(node: AstNode): ParsedPredicate | null {
    if (typeof node.subscribed === 'boolean') {
        return {
            field: 'subscribed',
            operator: 'is',
            values: [node.subscribed ? 'subscribed' : 'unsubscribed']
        };
    }

    if (typeof node.email_disabled === 'number') {
        if (node.email_disabled === 1) {
            return {
                field: 'subscribed',
                operator: 'is',
                values: ['email-disabled']
            };
        }

        if (node.email_disabled === 0) {
            return {
                field: 'subscribed',
                operator: 'is-not',
                values: ['email-disabled']
            };
        }
    }

    const compound = getCompound(node);

    if (!compound || compound.children.length !== 2) {
        return null;
    }

    let subscribedValue: boolean | undefined;
    let emailDisabledValue: number | undefined;

    for (const child of compound.children) {
        if (typeof child.subscribed === 'boolean') {
            subscribedValue = child.subscribed;
        }

        if (typeof child.email_disabled === 'number') {
            emailDisabledValue = child.email_disabled;
        }
    }

    if (compound.operator === '$and' && emailDisabledValue === 0 && subscribedValue !== undefined) {
        return {
            field: 'subscribed',
            operator: 'is',
            values: [subscribedValue ? 'subscribed' : 'unsubscribed']
        };
    }

    if (compound.operator === '$or' && emailDisabledValue === 1 && subscribedValue !== undefined) {
        return {
            field: 'subscribed',
            operator: 'is-not',
            values: [subscribedValue ? 'unsubscribed' : 'subscribed']
        };
    }

    return null;
}

function matchNewsletterGroupedNode(node: AstNode): ParsedPredicate | null {
    const compound = getCompound(node);

    if (!compound || compound.children.length !== 2) {
        return null;
    }

    let slug: string | undefined;
    let emailDisabledValue: number | undefined;

    for (const child of compound.children) {
        const newsletterSlug = child['newsletters.slug'];

        if (typeof newsletterSlug === 'string') {
            slug = newsletterSlug;
        }

        slug = readNegatedString(newsletterSlug) ?? slug;

        if (typeof child.email_disabled === 'number') {
            emailDisabledValue = child.email_disabled;
        }
    }

    if (!slug) {
        return null;
    }

    if (compound.operator === '$and' && emailDisabledValue === 0) {
        return {
            field: `newsletters.${slug}`,
            operator: 'is',
            values: ['subscribed']
        };
    }

    if (compound.operator === '$or' && emailDisabledValue === 1) {
        return {
            field: `newsletters.${slug}`,
            operator: 'is',
            values: ['unsubscribed']
        };
    }

    return null;
}

function matchFeedbackGroupedNode(node: AstNode): ParsedPredicate | null {
    const compound = getCompound(node);

    if (!compound || compound.operator !== '$and' || compound.children.length !== 2) {
        return null;
    }

    let postId: string | undefined;
    let score: number | undefined;

    for (const child of compound.children) {
        if (typeof child['feedback.post_id'] === 'string') {
            postId = child['feedback.post_id'];
        }

        if (typeof child['feedback.score'] === 'number') {
            score = child['feedback.score'];
        }
    }

    if (!postId || (score !== 0 && score !== 1)) {
        return null;
    }

    return {
        field: 'newsletter_feedback',
        operator: String(score),
        values: [postId]
    };
}

// Lifecycle encodings with no single field of their own: `subscribed` spans two columns,
// a newsletter pairs a slug with email_disabled, and feedback pairs a post with a score.
// Each is one predicate spread across a compound, so each needs a matcher here. A field
// whose codec declares its own grammar is reached through the catalogue instead.
const MEMBER_COMPOUND_MATCHERS: CompoundMatcher[] = [
    matchSubscribedNode,
    matchNewsletterGroupedNode,
    matchFeedbackGroupedNode
];

function parseMemberNode(node: AstNode, timezone: string): ParsedPredicate[] {
    for (const matcher of MEMBER_COMPOUND_MATCHERS) {
        const parsed = matcher(node);

        if (parsed) {
            return [parsed];
        }
    }

    const addressed = dispatchCompoundNode(node, memberFields, timezone);

    if (addressed) {
        return [addressed];
    }

    const compound = getCompound(node);

    if (compound?.operator === '$and') {
        return compound.children.flatMap(child => parseMemberNode(child, timezone));
    }

    return dispatchSimpleNodes([node], memberFields, timezone);
}

/**
 * Parses NQL into predicates. Pure: callers are responsible for filtering the
 * output via `isPredicateEnabled` against the field map they want to enforce.
 */
export function parseMemberFilter(filter: string | undefined, timezone: string): FilterPredicate[] {
    const ast = parseFilterToAst(filter ?? '');

    if (!ast) {
        return [];
    }

    return stampPredicates(parseMemberNode(ast, timezone));
}

export function hasTimezoneSensitiveMemberFilter(filter: string | undefined): boolean {
    const ast = parseFilterToAst(filter ?? '');

    if (!ast) {
        return false;
    }

    return hasFieldKey(ast, TIMEZONE_SENSITIVE_MEMBER_FIELDS);
}

/**
 * Serializes predicates back to NQL. Pure: callers should pre-filter via
 * `isPredicateEnabled` if they need to drop predicates the field map doesn't
 * advertise.
 */
export function serializeMemberFilters(predicates: FilterPredicate[], timezone: string): string | undefined {
    return serializePredicates(predicates, memberFields, timezone);
}
