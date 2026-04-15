-- Markdown inside block doc comments: code fences, lists, and paragraphs
-- must all terminate at `-/` rather than consuming it.

/--
# Heading

A paragraph with **bold** and *italic* text.

- first item
- second item

```lean
example : Nat := 42
```

Trailing paragraph.
-/
def afterCodeFence : Nat := 0

/-!
```
plain fenced block
```
-/
def afterPlainFence : Nat := 1
