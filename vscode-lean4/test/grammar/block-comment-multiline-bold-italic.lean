-- Pins a deliberate trade-off of the fix for the Zulip report
-- https://leanprover.zulipchat.com/#narrow/near/573942750: bold/italic
-- markdown spans inside Lean comments are NOT allowed to span multiple
-- lines. The `bold` and `italic` end patterns in
-- `lean4-markdown.json` carry an `|(?=$|-/)` clause so they close at end
-- of line or at the start of a `-/` doc-comment terminator.
--
-- Without this, a bold opener whose closer landed on the next line would
-- swallow text across the line boundary, and (worse) a same-line bold
-- whose closer was supposed to match `-/` would consume the doc-comment
-- terminator and keep the block comment open.

/--
**bold opener with no closer on this line
plain text on the next line — must NOT be tokenized as bold
-/
def afterMultilineBoldDocComment : Nat := 0

/--
*italic opener with no closer on this line
plain text on the next line — must NOT be tokenized as italic
-/
def afterMultilineItalicDocComment : Nat := 1

/-- **unterminated bold ends here -/
def afterSameLineUnterminatedBold : Nat := 2

/-- *unterminated italic ends here -/
def afterSameLineUnterminatedItalic : Nat := 3
