"use client";

import { useEffect, useState } from "react";
import { COMMON_HINDI_WORDS, HINGLISH_ALIASES } from "./hindi-common-words";
import { Transliterator, type LexiconEntry } from "./transliterate";

const COMMON: LexiconEntry[] = COMMON_HINDI_WORDS.map((word) => [word, 50]);
let base: Transliterator | null = null;
let full: Promise<Transliterator> | null = null;

/**
 * The Hinglish → Devanagari transliterator (ADR-061). Common words and rules
 * are ready at once; the archive word list (/translit/hi-lexicon.json) is
 * fetched the first time Hindi typing is switched on, and replaces them when
 * it arrives. A missing list is fine: typing still works without it.
 */
export function useHindiTransliterator(enabled: boolean): Transliterator | null {
  const [transliterator, setTransliterator] = useState<Transliterator | null>(null);

  useEffect(() => {
    if (!enabled) return;
    base ??= new Transliterator(COMMON, HINGLISH_ALIASES);
    setTransliterator((current) => current ?? base);
    full ??= fetch("/translit/hi-lexicon.json")
      .then((response) => (response.ok ? response.json() : { words: [] }))
      .catch(() => ({ words: [] }))
      .then((lexicon: { words?: LexiconEntry[] }) => new Transliterator([...COMMON, ...(lexicon.words ?? [])], HINGLISH_ALIASES));
    let alive = true;
    void full.then((ready) => {
      if (alive) setTransliterator(ready);
    });
    return () => {
      alive = false;
    };
  }, [enabled]);

  return enabled ? transliterator : null;
}
