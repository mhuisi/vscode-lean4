-- Fixture for the worker-crash test. The test changes line 3 (zero-indexed) to
-- an `#eval` that stops the worker of this file with an exit code.

#eval "worker alive"
