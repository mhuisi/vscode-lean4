-- Fixture for the InfoView go-to-definition test. In the goal `foo = 42`,
-- ctrl-click on `foo` must move the editor to `def foo` on line 3 (zero-indexed).

def foo : Nat := 42

example : foo = 42 := by
  sorry
