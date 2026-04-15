-- Baseline sanity fixture: common tokens across the grammar.
-- Regressions here catch broad breakage; focused bugs live in the other fixtures.

import Lean

namespace Example

def greeting : String := "hello, world"

/-- A documented function. -/
def double (n : Nat) : Nat := n + n

theorem double_add_one (n : Nat) : double n + 1 = 2 * n + 1 := by
  simp [double, Nat.two_mul]

#eval double 21

end Example
