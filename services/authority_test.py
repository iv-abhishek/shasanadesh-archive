from authority import as_logit, authority_score, scores_are_probabilities

# Probabilities and logits compare on one scale.
assert abs(as_logit(0.5)) < 1e-9
assert as_logit(3.2, is_probability=False) == 3.2
assert as_logit(0.7, is_probability=False) == 0.7
assert scores_are_probabilities([0.2, 0.9]) and not scores_are_probabilities([0.2, 3.1])

# Near-tie: the general order (A) outranks the in-context order (B).
assert authority_score(0.80, "A", None, "current") > authority_score(0.84, "B", None, "current")
# Rulebooks count as A even without a tier.
assert authority_score(0.80, None, "core-rules", None) > authority_score(0.84, "B", None, None)
# A clearly more relevant B page still wins.
assert authority_score(0.97, "B", None, None) > authority_score(0.40, "A", None, None)
# Superseded sinks below a current page of the same tier.
assert authority_score(0.90, "A", None, "superseded") < authority_score(0.80, "A", None, "current")
# Unsure routine orders (C) come last among near-ties.
assert authority_score(0.85, "C", None, None) < authority_score(0.80, "B", None, None)

# A confident routine order ranks below an unsure one, but a clearly better match still wins.
assert authority_score(0.85, "C", None, None, True, "high") < authority_score(0.85, "C", None, None, True, "low")
assert authority_score(0.995, "C", None, None, True, "high") > authority_score(0.60, "A", None, None)

print("authority ranking tests passed")
