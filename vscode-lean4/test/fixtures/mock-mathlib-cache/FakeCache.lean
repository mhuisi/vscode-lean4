-- A fake `cache` executable for the tests of `lean4.project.fetchCache` and
-- similar commands. It appends its arguments as one line to `cache-invoked.txt`.
def main (args : List String) : IO UInt32 := do
  IO.FS.withFile "cache-invoked.txt" .append fun h => h.putStrLn (" ".intercalate args)
  pure 0
