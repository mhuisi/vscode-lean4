-- Regression fixture for Zulipchat 573942750.
-- Trigger pattern: `-- **a*a**a*` — italic inside bold consumes the second `*`
-- of `**`, leaving bold without a closer. Bold must NOT persist past the end
-- of the `--` line comment.

-- **a*a**a*
-- plain text after the broken-bold line above

/-- **a*a**a* -/
def afterBlockDocComment : Nat := 0

-- *italic* **bold** ***both***
-- trailing plain text must tokenize as comment, not bold
