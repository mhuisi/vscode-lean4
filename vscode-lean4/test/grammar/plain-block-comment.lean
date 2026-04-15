-- Pins the tokenization of plain (non-doc) block comments `/- ... -/`
-- across single-line, multi-line, and nested forms. The doc variants
-- (`/-- ... -/`, `/-! ... -/`) are covered by `block-comment-markdown.lean`
-- and `block-comment-html.lean`; this fixture locks the plain variant so
-- a future grammar change that conflates the scopes (e.g. the outer
-- comment scope drifting from `comment.block.lean4` to
-- `comment.block.documentation.lean4`) is caught.
--
-- Note: markdown IS parsed inside plain `/- ... -/` blocks too — the
-- markdown sub-grammar is included for ALL Lean comment kinds, not just
-- the doc variants. So bold / inline-code spans below tokenize with their
-- markdown scopes nested under `comment.block.lean4`. The snapshot pins
-- both the outer `.lean4` (not `.documentation.lean4`) scope and the
-- inner markdown scopes.

/- single-line plain block comment -/
def afterSingleLinePlainBlock : Nat := 0

/- multi
   line
   plain
   block
   comment -/
def afterMultiLinePlainBlock : Nat := 1

/- outer
   /- nested -/
   still inside outer
-/
def afterNestedPlainBlock : Nat := 2

/- markdown markup like **bold** and `code` is parsed inside `/- ... -/`
   too (markdown sub-grammar applies to all Lean comment kinds), but the
   outer scope stays `comment.block.lean4` rather than the doc variant. -/
def afterMarkdownInPlainBlock : Nat := 3
