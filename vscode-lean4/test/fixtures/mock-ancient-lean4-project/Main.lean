-- Fixture for the "project pins a pre-stable Lean 4 toolchain" precondition
-- path. The `lean-toolchain` file pins `mock-ancient-lean4`, which the test
-- registers via `helpers/mockToolchain.ts` to print a fake `4.0.0-rc1`
-- version. Opening this file is expected to surface
-- `ancientLean4ProjectWarningMessage`.
def main : IO Unit := pure ()
