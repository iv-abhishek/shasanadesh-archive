from services.lexical import or_tsquery_sql, search_terms

assert search_terms("what are the bidders' past experience criteria as per GFR rules") == [
    "bidders", "past", "experience", "criteria", "gfr",
], search_terms("what are the bidders' past experience criteria as per GFR rules")
assert search_terms("Are the PSU exempted from EMD as per GeM GTC") == ["psu", "exempted", "emd", "gem", "gtc"]
hi = search_terms("निविदादाता का पूर्व अनुभव क्या होना चाहिए?")
assert hi[:3] == ["निविदादाता", "पूर्व", "अनुभव"], hi
assert "का" not in hi and "क्या" not in hi
# Nukta and zero-width joiners do not create a second spelling.
assert search_terms("फ़ाइल फाइल") == ["फाइल"]
assert search_terms("स्‍टार्टअप") == ["स्टार्टअप"]
# Numbers that matter stay; duplicates and single letters go.
assert search_terms("GO 2024 rule 149 a 149") == ["go", "2024", "149"]
assert search_terms("what is the") == []
assert len(search_terms(" ".join(f"word{i}" for i in range(30)))) == 12
assert or_tsquery_sql(2) == "(plainto_tsquery('simple', %s) || plainto_tsquery('simple', %s))"
print("lexical terms tests passed")
