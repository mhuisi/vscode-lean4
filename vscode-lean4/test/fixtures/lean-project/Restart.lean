-- `server-launch.test.ts`: each elaboration of this file shows another number,
-- so that the test can see that a restart elaborates the file again.
#eval (do return s!"elaboration {← IO.monoNanosNow}" : IO String)
