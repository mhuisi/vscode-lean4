-- Fixture for the "Messages" and "All Messages" InfoView tests. Zero-indexed lines:
--   line 5: `rfl` fails, because `1 + 1` is not definitionally equal to `3`
--   line 7: `#check` always emits an info message

example : 1 + 1 = 3 := by
  rfl

#check (1 + 1 : Nat)
