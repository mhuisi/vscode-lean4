-- Fixture used by the InfoView hover tests. Hovering identifiers in the goal
-- `n + 0 = n` (e.g. `Nat`) surfaces a popup with type information.

example (n : Nat) : n + 0 = n := by
  sorry
