-- Fixture for the "project pins a Lean 3 toolchain" precondition path.
-- The `lean-toolchain` file pins `mock-lean3`, which the test registers via
-- `helpers/mockToolchain.ts` to print a fake Lean 3 version. Opening this
-- file is expected to surface `lean3ProjectErrorMessage`.
def main : IO Unit := pure ()
