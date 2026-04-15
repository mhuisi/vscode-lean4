-- Fixture for the "lakefile present but no lean-toolchain" precondition path.
-- Opening this file is expected to surface clientProvider's
-- "has a Lakefile, but lacks a 'lean-toolchain' file" error.
def main : IO Unit := pure ()
