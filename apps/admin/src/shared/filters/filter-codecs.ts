import {columnAddressing, composeCodec} from './filter-addressing';
import {dateSemantics, numberSemantics, scalarSemantics, setSemantics, textSemantics} from './filter-semantics';
import type {FilterCodec} from './filter-types';
import type {ValueConfig} from './filter-semantics';

// The codecs a column-backed field uses: one of the vocabularies in filter-semantics.ts
// addressed as a plain NQL key. A field reached through a relation composes the same
// vocabularies with its own addressing instead — see filter-addressing.ts.

interface CodecConfig extends ValueConfig {
    field?: string;
}

export function scalarCodec(config?: CodecConfig): FilterCodec {
    return composeCodec(columnAddressing(config), scalarSemantics(config));
}

export function textCodec(config?: CodecConfig): FilterCodec {
    return composeCodec(columnAddressing(config), textSemantics());
}

export function setCodec(config?: CodecConfig): FilterCodec {
    return composeCodec(columnAddressing(config), setSemantics(config));
}

export function numberCodec(config?: CodecConfig): FilterCodec {
    return composeCodec(columnAddressing(config), numberSemantics());
}

export function dateCodec(config?: CodecConfig): FilterCodec {
    return composeCodec(columnAddressing(config), dateSemantics());
}
