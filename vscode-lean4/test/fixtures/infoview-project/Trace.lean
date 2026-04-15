-- Fixture for the trace-explorer InfoView test. `trace.Elab.step` emits
-- a message with structured trace data, which the infoview renders behind
-- a search toggle (codicon-go-to-search → codicon-search-stop).
set_option trace.Elab.step true in
#check (0 : Nat)
