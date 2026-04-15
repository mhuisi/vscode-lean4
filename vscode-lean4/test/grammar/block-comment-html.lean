-- Regression fixture for issues #369 and #656: HTML `begin/while` rules in the
-- markdown grammar used to escape past `-/`, swallowing subsequent Lean code.

/--
<pre>
some preformatted text
</pre>
-/
def afterPre : Nat := 1

/--
<div>
  nested content
</div>
-/
def afterDiv : Nat := 2

/-!
<script>
let x = 1
</script>
-/
def afterScript : Nat := 3
