-- Fixture for the test of a stopped server. Only this test opens the file, so that
-- the InfoView has no RPC session for it. Zero-indexed line 4: goal `3 + 3 = 6`.

example : 3 + 3 = 6 := by
  rfl
