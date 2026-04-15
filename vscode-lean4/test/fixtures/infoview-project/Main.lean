-- Fixture used by the InfoView UI tests. The tactic state at the cursor
-- positions before each `rfl` is the corresponding goal, which the tests
-- assert on.

example : 1 + 1 = 2 := by
  rfl

example : 2 + 2 = 4 := by
  rfl
